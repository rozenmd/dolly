import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineTask,
  type ConversationId,
  type Harness,
  type SettledSubmissionRecord,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { exceptionDetails } from "./diagnostics";
import { attempt, OperationError } from "./operations";
import type { SlackDelivery } from "./slack-events";
import type { IntakeAgent } from "./model-defaults";
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
  | { phase: "acknowledge" }
  | { phase: "prepare" }
  | { phase: "announce"; content: SlackPrepared["content"] }
  | { phase: "deliver"; content: SlackPrepared["content"] }
  | { phase: "reply"; text: string; attempts: number };

export interface SlackHost {
  /** Route, download attachments and build the prompt. Runs once per message; its result is checkpointed. */
  prepare(input: SlackDelivery, isNew: boolean): Effect.Effect<SlackPrepared, OperationError>;
  /** Post `text` in the thread. */
  reply(thread: SlackThread, text: string): Effect.Effect<void, OperationError>;
  /** Whether Slack is configured and enabled now; Settings can turn it off with the token kept. */
  enabled(): Effect.Effect<boolean, OperationError>;
  /** Add or remove the :eyes: reaction that shows a message has been picked up. */
  working(input: SlackDelivery, on: boolean): Effect.Effect<void, OperationError>;
  /** Tell the thread which Dolly session now owns it. */
  announce(input: SlackDelivery, conversationId: string): Effect.Effect<void, OperationError>;
}

/** Reactions and the session link are courtesy signals: a failure is logged, never retried into a duplicate. */
const bestEffort = (event: string, effect: Effect.Effect<void, OperationError>) =>
  effect.pipe(
    Effect.catchTag("OperationError", (error) =>
      Effect.logWarning({ event, error: exceptionDetails(error), details: error.details }),
    ),
  );

type TaskInput = SlackDelivery & { isNew: boolean };

/** A Slack thread a session answers in. */
export type SlackThread = { channel: string; threadTs: string };

/** What a settled turn posts back to Slack: only the text after the last tool call. */
async function answerText(tx: Tx, settled: SettledSubmissionRecord) {
  if (settled.status === "unanswered" || settled.type !== "input")
    return "Run failed: the request ended without an answer.";
  const entry = await tx.entry(AssistantEntry, settled.answer);
  const messages = (entry?.model ?? []).filter((message) => message.role === "assistant");
  const last = messages.at(-1);

  const text = (last?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

  const failure = last?.stopReason === "error" ? last.errorMessage : undefined;

  return failure ? `Run failed: ${failure}` : text;
}

export function slackDelivery(host: Omit<SlackHost, "enabled">) {
  return defineTask<TaskInput, Checkpoint, null>({
    name: "app.slack-delivery",
    version: 1,
    initial: () => ({ phase: "acknowledge" }),
    phases: {
      acknowledge: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* bestEffort("slack_working_failed", host.working(task.input, true));
            yield* attempt("slack.acknowledged", () =>
              runtime.commit(
                () => ({ status: "running", checkpoint: { phase: "prepare" } }),
                context,
              ),
            );
          }),
          { signal: context.abortSignal },
        ),
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
                  checkpoint: { phase: "announce", content: prepared.content },
                };
              }, context),
            );
          }),
          { signal: context.abortSignal },
        ),
      // A new thread hears which session took it, then loses :eyes:; follow-ups keep it until answered.
      announce: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (task.input.isNew) {
              yield* bestEffort(
                "slack_announce_failed",
                host.announce(task.input, String(task.conversationId)),
              );
              yield* bestEffort("slack_working_failed", host.working(task.input, false));
            }

            yield* attempt("slack.announced", () =>
              runtime.commit(
                () => ({
                  status: "running",
                  checkpoint: { phase: "deliver", content: task.state.checkpoint.content },
                }),
                context,
              ),
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
              runtime.commit(
                async (tx) => ({
                  status: "running",
                  checkpoint: { phase: "reply", text: await answerText(tx, settled), attempts: 0 },
                }),
                context,
              ),
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
              if (!task.input.isNew)
                yield* bestEffort("slack_working_failed", host.working(task.input, false));

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
              if (!task.input.isNew)
                yield* bestEffort("slack_working_failed", host.working(task.input, false));

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

/** Where a notice's answer goes, for the model writing it. */
const SLACK_NOTICE_NOTE =
  "This session's Slack thread gets your final reply automatically; do not post it yourself. Only the text after your last tool call is posted, so write a short, complete update there for someone who wasn't watching.";

/** A turn nobody typed in Slack, such as a review handoff: what to run and where to answer. */
export type SlackNoticeInput = SlackThread & { content: string; requestId: string };

type NoticeCheckpoint = { phase: "deliver" } | { phase: "reply"; text: string; attempts: number };

/**
 * Runs one system turn in a session a Slack thread owns and posts its answer in that thread, so
 * work the session does unasked (a review handoff) is seen where the person talks to it. No
 * reactions: there is no Slack message to react to.
 */
export function slackNotice(host: Pick<SlackHost, "reply" | "enabled">) {
  return defineTask<SlackNoticeInput, NoticeCheckpoint, null>({
    name: "app.slack-notice",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const conversation = yield* attempt("slack.notice.conversation", () =>
              runtime.conversation(task.conversationId, context),
            );

            if (!conversation) return yield* Effect.die("Slack conversation missing");

            const submission = yield* attempt("slack.notice.submit", () =>
              conversation.submit(
                {
                  type: "input",
                  content: `${task.input.content}\n\n${SLACK_NOTICE_NOTE}`,
                  requestId: task.input.requestId,
                  // Queued behind whatever the person is doing in that thread, never steering it.
                  whenBusy: "followUp",
                },
                context,
              ),
            );

            const settled = yield* attempt("slack.notice.wait", () => submission.wait(context));
            yield* attempt("slack.notice.checkpoint", () =>
              runtime.commit(
                async (tx) => ({
                  status: "running",
                  checkpoint: { phase: "reply", text: await answerText(tx, settled), attempts: 0 },
                }),
                context,
              ),
            );
          }),
          { signal: context.abortSignal },
        ),
      reply: (task, runtime, context) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { text, attempts } = task.state.checkpoint;

            // Nobody asked for this message, so it is never sent once Slack is turned off.
            const enabled = yield* host.enabled().pipe(Effect.result);

            if (Result.isSuccess(enabled) && !enabled.success) {
              yield* Effect.logInfo({ event: "slack_notice_skipped_disabled" });

              return yield* attempt("slack.notice.disabled", () =>
                runtime.commit(
                  () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
                  context,
                ),
              );
            }

            const result = Result.isFailure(enabled)
              ? Result.fail(enabled.failure)
              : text
                ? yield* host.reply(task.input, text).pipe(Effect.result)
                : Result.succeed(undefined);

            if (Result.isSuccess(result) || attempts >= 4) {
              if (Result.isFailure(result))
                yield* Effect.logError({
                  event: "slack_notice_reply_failed",
                  error: exceptionDetails(result.failure),
                  details: result.failure.details,
                });

              return yield* attempt("slack.notice.replied", () =>
                runtime.commit(
                  () =>
                    Result.isSuccess(result)
                      ? { status: "terminal", outcome: { status: "completed", result: null } }
                      : {
                          status: "terminal",
                          outcome: { status: "failed", error: { message: result.failure.message } },
                        },
                  context,
                ),
              );
            }

            yield* attempt("slack.notice.retry", () =>
              runtime.sleepUntil(
                Date.now() + 2 ** attempts * 5000,
                { phase: "reply", text, attempts: attempts + 1 },
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
 * Durably admit one Slack message before acknowledging Slack. A message in a thread already linked
 * to a session steers it from anyone in the workspace; a new thread must come from a listed member
 * (when any are listed).
 */
export const admitSlack = Effect.fn("Slack.admit")(function* (
  harness: Harness,
  delivery: ReturnType<typeof slackDelivery>,
  event: SlackDelivery,
  options: { members: readonly string[]; agent: IntakeAgent },
) {
  return yield* attempt("slack.intake", () =>
    harness.commit(async (tx) => {
      const state = await tx.doc(SlackThreads);
      const key = slackThreadKey(event.channel, event.threadTs);
      let thread = state.threads[key];
      const receipt = thread?.events[event.ts];

      if (receipt) return { status: "duplicate" as const, id: String(thread.id) };

      if (!thread && options.members.length && !options.members.includes(event.user))
        return { status: "forbidden" as const };

      const isNew = !thread;

      if (!thread) {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, conversation.id, options.agent);
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
