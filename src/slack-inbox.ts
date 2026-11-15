import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineTask,
  type ConversationId,
  type Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { exceptionDetails } from "./diagnostics";
import { attempt, OperationError } from "./operations";
import type { SlackDelivery } from "./slack-events";
import { ConversationWorkspace, workspaceConfig, type WorkspaceInput } from "./workspace";

/** Slack thread (`channel:threadTs`) → its Dolly conversation and the messages delivered to it. */
export const SlackThreads = defineDoc<{
  threads: Record<string, { id: ConversationId; events: Record<string, TaskId<null>> }>;
}>({
  kind: "app.slack-threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: () => false,
});

export type SlackPrepared = {
  content: string | ({ type: "text"; text: string } | ImageContent)[];
  workspace: typeof WorkspaceInput.Type | null;
};

type Checkpoint =
  | { phase: "prepare" }
  | { phase: "deliver"; content: SlackPrepared["content"] }
  | { phase: "reply"; text: string; attempts: number };

export interface SlackHost {
  /** Route, download attachments and build the prompt. Runs once per message; its result is checkpointed. */
  prepare(input: SlackDelivery, isNew: boolean): Effect.Effect<SlackPrepared, OperationError>;
  reply(input: SlackDelivery, text: string): Effect.Effect<void, OperationError>;
}

type TaskInput = SlackDelivery & { isNew: boolean };

export function slackDelivery(host: SlackHost) {
  return defineTask<TaskInput, Checkpoint, null>({
    name: "app.slack-delivery",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const prepared = yield* host.prepare(task.input, task.input.isNew).pipe(
              Effect.catchTag("OperationError", (error) =>
                Effect.logError({
                  event: "slack_prepare_failed",
                  error: exceptionDetails(error),
                }).pipe(
                  Effect.as({
                    content: task.input.text,
                    workspace: null,
                  } satisfies SlackPrepared),
                ),
              ),
            );

            yield* attempt("slack.prepared", () =>
              runtime.commit(async (tx) => {
                if (prepared.workspace) {
                  const state = await tx.doc(ConversationWorkspace, task.conversationId);

                  // Routing only chooses the checkout for a new thread; it never moves existing work.
                  if (!state.config)
                    state.config = workspaceConfig(prepared.workspace, String(task.conversationId));
                }

                return {
                  status: "running",
                  checkpoint: { phase: "deliver", content: prepared.content },
                };
              }, context),
            );
          }),
          { signal: context.abortSignal },
        ),
      deliver: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const conversation = yield* attempt("slack.conversation", () =>
              runtime.conversation(task.conversationId, context),
            );

            if (!conversation) return yield* Effect.die("Slack conversation missing");

            const submission = yield* attempt("slack.submit", () =>
              conversation.submit(
                {
                  type: "input",
                  content: task.state.checkpoint.content,
                  requestId: `slack:${task.input.channel}:${task.input.ts}`,
                  whenBusy: "followUp",
                },
                context,
              ),
            );

            const settled = yield* attempt("slack.wait", () => submission.wait(context));
            yield* attempt("slack.checkpoint", () =>
              runtime.commit(async (tx) => {
                if (settled.status === "unanswered" || settled.type !== "input")
                  return {
                    status: "running",
                    checkpoint: {
                      phase: "reply",
                      text: "Run failed: the request ended without an answer.",
                      attempts: 0,
                    },
                  };
                const entry = await tx.entry(AssistantEntry, settled.answer);

                // Only the text after the last tool call is posted, as in Open Session.
                const messages = (entry?.model ?? []).filter(
                  (message) => message.role === "assistant",
                );

                const last = messages.at(-1);

                const text = (last?.content ?? [])
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n")
                  .trim();

                const failure = last?.stopReason === "error" ? last.errorMessage : undefined;

                return {
                  status: "running",
                  checkpoint: {
                    phase: "reply",
                    text: failure ? `Run failed: ${failure}` : text,
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
            const text = task.state.checkpoint.text;

            const result = text
              ? yield* host.reply(task.input, text).pipe(Effect.result)
              : Result.succeed(undefined);

            if (Result.isSuccess(result)) {
              yield* attempt("slack.replied", () =>
                runtime.commit(
                  () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                  context,
                ),
              );

              return;
            }

            yield* Effect.logError({
              event: "slack_reply_failed",
              error: exceptionDetails(result.failure),
              details: result.failure.details,
            });

            if (task.state.checkpoint.attempts >= 4) {
              yield* attempt("slack.failed", () =>
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

            yield* attempt("slack.retry", () =>
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

export const slackThreadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`;

/**
 * Durably admit one Slack message before acknowledging Slack, as Open Session's event inbox
 * does. A message in a thread already linked to a session steers it even when the sender is
 * not the allowed user; anything else must come from the allowed user (when one is set).
 */
export const admitSlack = Effect.fn("Slack.admit")(function* (
  harness: Harness,
  delivery: ReturnType<typeof slackDelivery>,
  event: SlackDelivery,
  options: { allowedUserId: string | null; model: { provider: string; modelId: string } },
) {
  return yield* attempt("slack.intake", () =>
    harness.commit(async (tx) => {
      const state = await tx.doc(SlackThreads);
      const key = slackThreadKey(event.channel, event.threadTs);
      let thread = state.threads[key];
      const receipt = thread?.events[event.ts];

      if (receipt) return { status: "duplicate" as const, id: String(thread.id) };

      if (!thread && options.allowedUserId && event.user !== options.allowedUserId)
        return { status: "forbidden" as const };

      const isNew = !thread;

      if (!thread) {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, conversation.id, { model: options.model });
        thread = { id: conversation.id, events: {} };
      }

      const taskId = await tx.createTask(
        delivery,
        { ...event, isNew },
        { conversationId: thread.id, ownership: { kind: "conversation" }, background: true },
      );

      state.threads[key] = { id: thread.id, events: { ...thread.events, [event.ts]: taskId } };

      return { status: "accepted" as const, id: String(thread.id), taskId: String(taskId), isNew };
    }, BACKGROUND_CONTEXT),
  );
});
