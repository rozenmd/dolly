import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineTask,
  type ConversationId,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import { exceptionDetails } from "./diagnostics";
import {
  ConversationWorkspace,
  pinReviewWorkspace,
  READ_ONLY_TOOLS,
  workspaceConfig,
} from "./workspace";
import { deliveryKey, type GitHubDelivery, type GitHubReview } from "./github-webhook";
import {
  cappedComment,
  handoffKey,
  handoffMessage,
  nextHandoffState,
  parseVerdict,
  planHandoff,
  ReviewHandoffs,
  stripVerdict,
  VERDICT_INSTRUCTION,
  type ReviewFindings,
  type ReviewVerdict,
} from "./review-handoff";
import { attempt, OperationError } from "./operations";
import type { IntakeAgent } from "./model-defaults";

/** Code changes land on the PR itself, the way a person fixing it would push them. */
const GITHUB_PR_NOTE =
  "To change this PR, read it with github read_pull_request. If it is open and head.repository is this repository, commit to its head branch and push with git push origin HEAD:<head.ref> (force-push only when you rewrote history). If it is closed, merged or from a fork, push to this session's branch and open a new PR instead.";

export const GitHubThreads = defineDoc<{
  threads: Record<string, { id: ConversationId; events: Record<string, TaskId<null>> }>;
}>({
  kind: "app.github-threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: () => false,
});

/** The prompt for an automatic review. The agent publishes the review itself, inline comments included. */
function reviewPrompt(review: Extract<GitHubDelivery, { kind: "review" }>) {
  return [
    review.pushed
      ? `GitHub PR ${review.repository}#${review.number} has new commits (pushed by @${review.sender}, head ${review.sha}). Review the new head. Any earlier reviews of this PR are above: check whether their findings were addressed and don't repeat ones that were.`
      : `GitHub PR ${review.repository}#${review.number} is ready for review (opened by @${review.sender}, head ${review.sha}). Review it.`,
    `Read it with github read_pull_request and list_pull_request_files, check out the code in the sandbox when the diff alone is not enough, and look for bugs, security problems, missing tests and anything that breaks the repository's own guidance (AGENTS.md, skills). Report real problems, not style nits, and say so plainly when it looks good.`,
    `Publish exactly one review with github create_review: event COMMENT, commit_id ${review.sha}, inline comments on the lines concerned and a short overall summary as the body. This session is read-only: it cannot change files, push, edit the PR or open new PRs, so suggest fixes in the review instead. If create_review reports that the head moved, do not review the new head; say so instead.`,
    `Finish with the same short summary. If you could not publish the review, that answer is posted as the review instead.`,
    VERDICT_INSTRUCTION,
  ].join("\n\n");
}

type Review = typeof GitHubReview.Type;

type PullHead = { open: boolean; sha: string; ref: string; repository: string | null };

/** Whether `head` is still the open pull request head `review` was made for, on the same repository. */
const isCurrent = (review: Review, head: PullHead) =>
  head.open && head.sha === review.sha && head.repository === review.repository;

type Checkpoint =
  | { phase: "deliver" }
  | { phase: "reply"; text: string; attempts: number; verdict?: ReviewVerdict }
  | { phase: "handoff"; text: string; verdict: ReviewVerdict };

export type HandoffDeps = {
  /** Whether automatic reviews are still turned on; checked again before each review and handoff. */
  enabled: () => Effect.Effect<boolean, OperationError>;
  /** The PR's state and head, read fresh: a stale head is neither reviewed nor handed off. */
  head: (review: Review) => Effect.Effect<PullHead, OperationError>;
  /** This App's own review of `review.sha`, and nothing any other author wrote. */
  findings: (review: Review) => Effect.Effect<ReviewFindings | undefined, OperationError>;
  /** The live, writable session that opened the PR and owns its head `branch`, if any. */
  owner: (review: Review, branch: string) => Promise<ConversationId | undefined>;
  /** Posts a comment on the PR. */
  comment: (review: Review, body: string) => Effect.Effect<void, OperationError>;
};

export function githubDelivery({
  reply,
  finished,
  handoff,
}: {
  reply: (event: GitHubDelivery, text: string) => Effect.Effect<void, OperationError>;
  /** Marks the command's comment (or a review's PR) as done. Best effort: the answer is already posted. */
  finished: (event: GitHubDelivery) => Effect.Effect<void, OperationError>;
  handoff: HandoffDeps;
}) {
  return defineTask<GitHubDelivery, Checkpoint, null>({
    name: "app.github-delivery",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const conversation = yield* attempt("github.conversation", () =>
              runtime.conversation(task.conversationId, context),
            );

            if (!conversation) return yield* Effect.die("GitHub conversation missing");

            // Pushes queue reviews behind each other. Once it is this review's turn, skip it if
            // reviews were turned off meanwhile, or if the head has moved on (the newest head's own
            // review covers it); otherwise pin the session's checkout to exactly this head.
            if ("kind" in task.input) {
              yield* attempt("github.idle", () => conversation.waitForIdle(context));
              const review = task.input;

              const enabled = yield* handoff.enabled();

              const current =
                enabled &&
                (yield* handoff.head(review).pipe(
                  Effect.map((head) => isCurrent(review, head)),
                  Effect.catchTag("OperationError", () => Effect.succeed(true)),
                ));

              if (!current) {
                yield* Effect.logInfo({
                  event: enabled ? "github_review_skipped_stale" : "github_review_skipped_disabled",
                  pull: `${review.repository}#${review.number}`,
                  sha: review.sha,
                });

                return yield* attempt("github.skipped", () =>
                  runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                    context,
                  ),
                );
              }

              yield* attempt("github.pin", () =>
                runtime.commit(async (tx) => {
                  pinReviewWorkspace(
                    await tx.doc(ConversationWorkspace, task.conversationId),
                    review.repository,
                    review.sha,
                    String(task.conversationId),
                  );

                  return undefined;
                }, context),
              );
            }

            const submission = yield* attempt("github.submit", () =>
              conversation.submit(
                {
                  type: "input",
                  content:
                    "kind" in task.input
                      ? reviewPrompt(task.input)
                      : `GitHub PR ${task.input.repository}#${task.input.number}, comment by @${task.input.sender}:\n\n${task.input.content}\n\n${GITHUB_PR_NOTE}`,
                  requestId:
                    "kind" in task.input
                      ? `github:review:${task.input.repository}#${task.input.number}:${task.input.sha}`
                      : `github:comment:${task.input.commentId}`,
                  whenBusy: "followUp",
                },
                context,
              ),
            );

            const settled = yield* attempt("github.wait", () => submission.wait(context));
            yield* attempt("github.checkpoint", () =>
              runtime.commit(async (tx) => {
                if (settled.status === "unanswered" || settled.type !== "input")
                  return {
                    status: "terminal",
                    outcome: {
                      status: "failed",
                      error: { message: "GitHub request ended without an answer" },
                    },
                  };
                const entry = await tx.entry(AssistantEntry, settled.answer);

                const text = (entry?.model ?? [])
                  .flatMap((message) =>
                    message.role === "assistant"
                      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                      : [],
                  )
                  .join("\n");

                // A review's verdict line is for the loop, not for people reading the review.
                const verdict = "kind" in task.input ? parseVerdict(text) : undefined;
                const shown = ("kind" in task.input ? stripVerdict(text) : text).slice(0, 16_384);

                const checkpoint: Checkpoint = {
                  phase: "reply",
                  text: shown || "The agent completed without a text response.",
                  attempts: 0,
                };

                if (verdict) checkpoint.verdict = verdict;

                return { status: "running", checkpoint };
              }, context),
            );
          }),
          { signal: context.abortSignal },
        ),
      reply: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* reply(task.input, task.state.checkpoint.text).pipe(Effect.result);

            if (Result.isSuccess(result)) {
              yield* finished(task.input).pipe(
                Effect.catchTag("OperationError", (error) =>
                  Effect.logError({
                    event: "github_reaction_failed",
                    reaction: "rocket",
                    error: exceptionDetails(error),
                    details: error.details,
                  }),
                ),
              );
              const { text, verdict } = task.state.checkpoint;

              yield* attempt("github.replied", () =>
                runtime.commit(
                  () =>
                    "kind" in task.input && verdict
                      ? {
                          status: "running",
                          checkpoint: { phase: "handoff", text, verdict },
                        }
                      : { status: "terminal", outcome: { status: "completed", result: null } },
                  context,
                ),
              );

              return;
            }

            yield* Effect.logError({
              event: "github_reply_failed",
              error: exceptionDetails(result.failure),
              details: result.failure.details,
            });

            if (task.state.checkpoint.attempts >= 4) {
              yield* attempt("github.failed", () =>
                runtime.commit(
                  () => ({
                    status: "terminal",
                    outcome: { status: "failed", error: { message: result.failure.message } },
                  }),
                  context,
                ),
              );

              return;
            }

            yield* attempt("github.retry", () =>
              runtime.sleepUntil(
                Date.now() + 2 ** task.state.checkpoint.attempts * 5000,
                { ...task.state.checkpoint, attempts: task.state.checkpoint.attempts + 1 },
                context,
              ),
            );
          }),
          { signal: context.abortSignal },
        ),
      handoff: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { verdict } = task.state.checkpoint;

            const done = {
              status: "terminal",
              outcome: { status: "completed", result: null },
            } as const;

            if (!("kind" in task.input))
              return yield* attempt("github.handoff.done", () =>
                runtime.commit(() => done, context),
              );
            const review = task.input;
            const key = handoffKey(review.repository, review.number);

            // Turning reviews off stops the loop, also for reviews admitted before that.
            const enabled = yield* handoff.enabled();

            // Findings about a head that has moved on would only confuse the session.
            const head = enabled ? yield* handoff.head(review) : undefined;
            const current = head !== undefined && isCurrent(review, head);

            // Only the session that owns the PR's head branch gets the findings, and only Dolly's
            // own review of this exact head: never comments or reviews by anyone else.
            const owner =
              head && current
                ? yield* attempt("github.handoff.owner", () => handoff.owner(review, head.ref))
                : undefined;

            const findings = owner ? yield* handoff.findings(review) : undefined;

            const target =
              owner && findings
                ? yield* attempt("github.handoff.target", () =>
                    runtime.conversation(owner, context),
                  )
                : undefined;

            let announce = false;

            yield* attempt("github.handoff.commit", () =>
              runtime.commit(async (tx) => {
                if (!target || !findings || !head) return done;
                const state = await tx.doc(ReviewHandoffs);
                const prior = state.pulls[key];
                const plan = planHandoff(prior, review.sha, verdict);
                const content = handoffMessage(review, verdict, findings, head.ref, plan);

                if (content)
                  await target.submit(tx, {
                    type: "input",
                    content,
                    requestId: `review-handoff:${key}:${review.sha}`,
                    whenBusy: "followUp",
                  });

                announce = plan.kind === "capped" && plan.announce;
                state.pulls[key] = nextHandoffState(
                  prior,
                  plan,
                  review.sha,
                  String(target.id),
                  runtime.now(),
                );

                return done;
              }, context),
            );

            yield* Effect.logInfo({
              event: "github_review_handoff",
              pull: key,
              sha: review.sha,
              owner: owner ? String(owner) : null,
              enabled,
              current,
              findings: findings?.id ?? null,
              verdict,
            });

            // Best effort, once: the cap is already recorded and the task already finished.
            if (announce)
              yield* handoff.comment(review, cappedComment(review.number)).pipe(
                Effect.catchTag("OperationError", (error) =>
                  Effect.logError({
                    event: "github_review_handoff_cap_comment_failed",
                    error: exceptionDetails(error),
                    details: error.details,
                  }),
                ),
              );
          }).pipe(
            // A missed handoff costs a fix round, never the review, which is already posted.
            Effect.catchTag("OperationError", (error) =>
              Effect.logError({
                event: "github_review_handoff_failed",
                error: exceptionDetails(error),
                details: error.details,
              }).pipe(
                Effect.andThen(
                  attempt("github.handoff.failed", () =>
                    runtime.commit(
                      () => ({
                        status: "terminal",
                        outcome: { status: "completed", result: null },
                      }),
                      context,
                    ),
                  ),
                ),
              ),
            ),
          ),
          { signal: context.abortSignal },
        ),
    },
    abort: (_, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}

export const admitGitHub = Effect.fn("GitHub.admit")(function* (
  harness: Harness,
  delivery: ReturnType<typeof githubDelivery>,
  event: GitHubDelivery,
  agent: IntakeAgent,
) {
  return yield* attempt("github.intake", () =>
    harness.commit(async (tx) => {
      const state = await tx.doc(GitHubThreads);
      const review = "kind" in event;
      // Reviews get their own read-only session; /dolly commands on the same PR get a writable one.
      const key = `${review ? "review:" : ""}${event.repository}#${event.number}`;
      let thread = state.threads[key];
      const receipt = thread?.events[deliveryKey(event)];

      if (receipt)
        return {
          status: 202 as const,
          id: String(thread.id),
          taskId: String(receipt),
          duplicate: true,
        };

      if (!thread) {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, conversation.id, agent);

        // An allowlist, so tools added later are not offered to a read-only session.
        if (review) (await tx.doc(AgentDoc, conversation.id)).tools = [...READ_ONLY_TOOLS];
        const workspace = await tx.doc(ConversationWorkspace, conversation.id);
        workspace.config = workspaceConfig(
          { repository: event.repository, ref: `refs/pull/${event.number}/head` },
          String(conversation.id),
          { readOnly: review },
        );
        thread = { id: conversation.id, events: {} };
      }

      const taskId = await tx.createTask(delivery, event, {
        conversationId: thread.id,
        ownership: { kind: "conversation" },
        background: true,
      });

      state.threads[key] = {
        id: thread.id,
        events: { ...thread.events, [deliveryKey(event)]: taskId },
      };

      return {
        status: 202 as const,
        id: String(thread.id),
        taskId: String(taskId),
        duplicate: false,
      };
    }, BACKGROUND_CONTEXT),
  );
});
