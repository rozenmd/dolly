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
  type LastReview,
  handoffMessage,
  nextHandoffState,
  openFeedback,
  parseVerdict,
  planHandoff,
  ReviewHandoffs,
  stripVerdict,
  type ReviewVerdict,
} from "./review-handoff";
import { reviewPrompt, type PullReviewContext } from "./review-prompt";
import { attempt, OperationError } from "./operations";
import type { IntakeAgent } from "./model-defaults";

/** Code changes land on the PR itself, the way a person fixing it would push them. */
const GITHUB_PR_NOTE =
  "To change this PR, read it with github read_pull_request. If it is open and head.repository is this repository, commit to its head branch and push with git push origin HEAD:<head.ref> (force-push only when you rewrote history). If it is closed, merged or from a fork, push to this session's branch and open a new PR instead.";

export const GitHubThreads = defineDoc<{
  threads: Record<
    string,
    {
      id: ConversationId;
      events: Record<string, TaskId<null>>;
      /** For a review: the same PR's previous review task, which this one runs after. */
      after?: TaskId<null>;
    }
  >;
  /** Each PR's newest review task, by `repository#number`. */
  latestReview?: Record<string, TaskId<null>>;
}>({
  kind: "app.github-threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: () => false,
});

type Review = typeof GitHubReview.Type;

/** Each reviewed head gets a session of its own. */
const reviewThreadKey = (review: Pick<Review, "repository" | "number" | "sha">) =>
  `review:${review.repository}#${review.number}@${review.sha}`;

const commentPrompt = (event: Exclude<GitHubDelivery, { kind: "review" }>) =>
  `GitHub PR ${event.repository}#${event.number}, comment by @${event.sender}:\n\n${event.content}\n\n${GITHUB_PR_NOTE}`;

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
  /** The PR's description, conversation, review threads and reviews, read fresh. */
  pull: (review: Review) => Effect.Effect<PullReviewContext, OperationError>;
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

            let content = "kind" in task.input ? "" : commentPrompt(task.input);

            // Each head is reviewed in a fresh session of its own, after OpenSession: the review
            // reads the full diff at that commit, with a digest of earlier reviews for continuity.
            // Pushes still queue reviews behind each other. Once it is this review's turn, skip it
            // if reviews were turned off meanwhile, or if the head has moved on (the newest head's
            // own review covers it); otherwise pin the session's checkout to exactly this head.
            if ("kind" in task.input) {
              const review = task.input;

              let after: TaskId<null> | undefined;

              yield* attempt("github.after", () =>
                runtime.commit(async (tx) => {
                  after = (await tx.doc(GitHubThreads)).threads[reviewThreadKey(review)]?.after;

                  return undefined;
                }, context),
              );

              if (after) {
                const previous = after;
                yield* attempt("github.after.wait", () => runtime.waitForTask(previous, context));
              }

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

              // Without the PR's context the review still runs, as a first look at the diff.
              const pull = yield* handoff.pull(review).pipe(
                Effect.catchTag("OperationError", (error) =>
                  Effect.logWarning({
                    event: "github_review_context_failed",
                    error: exceptionDetails(error),
                    details: error.details,
                  }).pipe(Effect.as(undefined)),
                ),
              );

              let lastReview: LastReview | undefined;

              yield* attempt("github.pin", () =>
                runtime.commit(async (tx) => {
                  pinReviewWorkspace(
                    await tx.doc(ConversationWorkspace, task.conversationId),
                    review.repository,
                    review.sha,
                    String(task.conversationId),
                  );

                  const found = (await tx.doc(ReviewHandoffs)).pulls[
                    handoffKey(review.repository, review.number)
                  ]?.lastReview;

                  // A copy: the document is only readable inside this transaction.
                  if (found) lastReview = { ...found };

                  return undefined;
                }, context),
              );

              content = reviewPrompt(review, pull, lastReview);
            }

            const submission = yield* attempt("github.submit", () =>
              conversation.submit(
                {
                  type: "input",
                  content,
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
            // A review is never published against a head that moved while it ran, after
            // OpenSession: the newer head's own review covers the PR.
            if ("kind" in task.input && task.state.checkpoint.attempts === 0) {
              const review = task.input;

              const current = yield* handoff.head(review).pipe(
                Effect.map((head) => isCurrent(review, head)),
                Effect.catchTag("OperationError", () => Effect.succeed(true)),
              );

              if (!current) {
                yield* Effect.logInfo({
                  event: "github_review_superseded_during_run",
                  pull: `${review.repository}#${review.number}`,
                  sha: review.sha,
                });

                return yield* attempt("github.superseded", () =>
                  runtime.commit(
                    () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                    context,
                  ),
                );
              }
            }

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

            // What this review concluded is the next review's starting point, whatever the loop
            // does with it.
            yield* attempt("github.handoff.record", () =>
              runtime.commit(async (tx) => {
                const state = await tx.doc(ReviewHandoffs);

                state.pulls[key] = {
                  ...state.pulls[key],
                  rounds: state.pulls[key]?.rounds ?? 0,
                  lastReview: { ...verdict, sha: review.sha, at: runtime.now() },
                };

                return undefined;
              }, context),
            );

            // Turning reviews off stops the loop, also for reviews admitted before that.
            const enabled = yield* handoff.enabled();

            // Findings about a head that has moved on would only confuse the session.
            const head = enabled ? yield* handoff.head(review) : undefined;
            const current = head !== undefined && isCurrent(review, head);

            // Only the session that owns the PR's head branch gets the findings, and only open
            // feedback from trusted authors: never anything an untrusted account wrote.
            const owner =
              head && current
                ? yield* attempt("github.handoff.owner", () => handoff.owner(review, head.ref))
                : undefined;

            const pull = owner ? yield* handoff.pull(review) : undefined;
            const findings = pull ? openFeedback(pull, review.sha) : undefined;

            const target =
              owner && findings
                ? yield* attempt("github.handoff.target", () =>
                    runtime.conversation(owner, context),
                  )
                : undefined;

            let announce = false;

            yield* attempt("github.handoff.commit", () =>
              runtime.commit(async (tx) => {
                if (!target || !findings || !head || !pull) return done;
                const state = await tx.doc(ReviewHandoffs);
                const prior = state.pulls[key];
                const plan = planHandoff(prior, review.sha, verdict);

                const content = handoffMessage(
                  review,
                  verdict,
                  findings,
                  { title: pull.title, ref: head.ref },
                  plan,
                );

                // Queued behind whatever the person is doing in that session, never steering it.
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
              findings: findings?.items.length ?? null,
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
      // Each reviewed head gets a fresh read-only session; /dolly commands on the same PR share a
      // writable one.
      const pull = `${event.repository}#${event.number}`;
      const key = "kind" in event ? reviewThreadKey(event) : pull;
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

        // Reviews of one PR run one after another, each after the previous head's.
        const previous = review ? state.latestReview?.[pull] : undefined;

        if (previous) thread.after = previous;
      }

      const taskId = await tx.createTask(delivery, event, {
        conversationId: thread.id,
        ownership: { kind: "conversation" },
        background: true,
      });

      state.threads[key] = {
        ...thread,
        events: { ...thread.events, [deliveryKey(event)]: taskId },
      };

      if (review) state.latestReview = { ...state.latestReview, [pull]: taskId };

      return {
        status: 202 as const,
        id: String(thread.id),
        taskId: String(taskId),
        duplicate: false,
      };
    }, BACKGROUND_CONTEXT),
  );
});
