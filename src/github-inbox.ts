import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  defineTask,
  type ConversationId,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import { exceptionDetails } from "./diagnostics";
import { GitHubEvent } from "./github-webhook";
import { attempt, OperationError } from "./operations";

export const GitHubThreads = defineDoc<{
  threads: Record<string, { id: ConversationId; events: Record<string, TaskId<null>> }>;
}>({
  kind: "app.github-threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: () => false,
});

type Checkpoint = { phase: "deliver" } | { phase: "reply"; text: string; attempts: number };

export function githubDelivery(
  reply: (event: typeof GitHubEvent.Type, text: string) => Effect.Effect<void, OperationError>,
) {
  return defineTask<typeof GitHubEvent.Type, Checkpoint, null>({
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
                  content: `GitHub PR ${task.input.repository}#${task.input.number}, comment by @${task.input.sender}:\n\n${task.input.content}`,
                  requestId: `github:comment:${task.input.commentId}`,
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
  event: typeof GitHubEvent.Type,
) {
  return yield* attempt("github.intake", () =>
    harness.commit(async (tx) => {
      const state = await tx.doc(GitHubThreads);
      const key = `${event.repository}#${event.number}`;
      let thread = state.threads[key];
      const receipt = thread?.events[String(event.commentId)];

      if (receipt)
        return {
          status: 202 as const,
          id: String(thread.id),
          taskId: String(receipt),
          duplicate: true,
        };

      if (!thread) {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        thread = { id: conversation.id, events: {} };
      }

      const taskId = await tx.createTask(delivery, event, {
        conversationId: thread.id,
        ownership: { kind: "conversation" },
        background: true,
      });

      state.threads[key] = {
        id: thread.id,
        events: { ...thread.events, [String(event.commentId)]: taskId },
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
