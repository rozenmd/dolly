import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
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
import { ConversationWorkspace, workspaceConfig } from "./workspace";
import { deliveryKey, type GitHubDelivery } from "./github-webhook";
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
    `GitHub PR ${review.repository}#${review.number} is ready for review (opened by @${review.sender}, head ${review.sha}). Review it.`,
    `Read it with github read_pull_request and list_pull_request_files, check out the code in the sandbox when the diff alone is not enough, and look for bugs, security problems, missing tests and anything that breaks the repository's own guidance (AGENTS.md, skills). Report real problems, not style nits, and say so plainly when it looks good.`,
    `Publish exactly one review with github create_review: event COMMENT, commit_id ${review.sha}, inline comments on the lines concerned and a short overall summary as the body. Do not push, edit the PR or open new PRs. If create_review reports that the head moved, do not review the new head; say so instead.`,
    `Finish with the same short summary. If you could not publish the review, that answer is posted as the review instead.`,
  ].join("\n\n");
}

type Checkpoint = { phase: "deliver" } | { phase: "reply"; text: string; attempts: number };

export function githubDelivery({
  reply,
  finished,
}: {
  reply: (event: GitHubDelivery, text: string) => Effect.Effect<void, OperationError>;
  /** Marks the command's comment (or a review's PR) as done. Best effort: the answer is already posted. */
  finished: (event: GitHubDelivery) => Effect.Effect<void, OperationError>;
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
                  .join("\n")
                  .slice(0, 16_384);

                return {
                  status: "running",
                  checkpoint: {
                    phase: "reply",
                    text: text || "The agent completed without a text response.",
                    attempts: 0,
                  },
                };
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
              yield* attempt("github.replied", () =>
                runtime.commit(
                  () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
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
      const key = `${event.repository}#${event.number}`;
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
        const workspace = await tx.doc(ConversationWorkspace, conversation.id);
        workspace.config = workspaceConfig(
          { repository: event.repository, ref: `refs/pull/${event.number}/head` },
          String(conversation.id),
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
