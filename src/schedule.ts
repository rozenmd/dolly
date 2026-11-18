import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineTask,
  defineTool,
  type ConversationId,
  type Harness,
  type TaskId,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";

export const MAX_SCHEDULED = 20;
export const MAX_DELAY_MINUTES = 30 * 24 * 60;

type Scheduled = { taskId: TaskId<ScheduleResult>; at: number; createdAt: number; prompt: string };

type ScheduleInput = { prompt: string; at: number; createdAt: number };

type ScheduleResult = { status: "delivered" };

/** Pending scheduled prompts of one conversation; delivery and abort remove their own entry. */
const ScheduledPrompts = defineDoc<{ pending: Record<string, Scheduled> }>({
  kind: "app.scheduled-prompts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: {} }),
  checkpointWhen: () => false,
});

const iso = (at: number) => new Date(at).toISOString();

/** The message a schedule submits, labelled so the model and the owner can tell it was scheduled. */
export function scheduledMessage(id: string, input: ScheduleInput) {
  return `[Scheduled prompt ${id}, set at ${iso(input.createdAt)} for ${iso(input.at)}]\n\n${input.prompt}`;
}

/**
 * Sleeps in Pi's durable task store until `at`, so it survives restarts and Durable Object eviction:
 * the Agent's `onWake` alarm wakes the harness at the earliest sleep. Then it submits the prompt to
 * its own conversation as a follow-up, in the same commit that ends the task.
 */
const ScheduledPrompt = defineTask<
  ScheduleInput,
  { phase: "wait" } | { phase: "deliver" },
  ScheduleResult
>({
  name: "app.scheduled-prompt",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: (task, runtime, context) =>
      runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
    deliver: async (task, runtime, context) => {
      const conversation = await runtime.conversation(runtime.conversationId, context);

      if (!conversation) throw new Error("Scheduled prompt conversation missing");

      await runtime.commit(async (tx) => {
        const state = await tx.doc(ScheduledPrompts, runtime.conversationId);
        delete state.pending[String(task.id)];
        await conversation.submit(tx, {
          type: "input",
          content: scheduledMessage(String(task.id), task.input),
          requestId: `schedule:${task.id}`,
          whenBusy: "followUp",
        });

        return {
          status: "terminal",
          outcome: { status: "completed", result: { status: "delivered" } },
        };
      }, context);
    },
  },
  abort: (task, runtime, context) =>
    runtime.commit(async (tx) => {
      const state = await tx.doc(ScheduledPrompts, runtime.conversationId);
      delete state.pending[String(task.id)];

      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
});

export const scheduleTasks = [ScheduledPrompt];

export const SCHEDULE_TOOL_NAMES = [
  "schedule_prompt",
  "list_scheduled_prompts",
  "cancel_scheduled_prompt",
] as const;

/** Parse an absolute time; an explicit offset (or Z) is required so the zone is never guessed. */
function parseAt(at: string) {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at.trim())) return undefined;
  const time = Date.parse(at);

  return Number.isNaN(time) ? undefined : time;
}

export class Scheduler {
  constructor(
    private readonly getHarness: () => Harness,
    private readonly now: () => number = Date.now,
  ) {}

  private get harness() {
    return this.getHarness();
  }

  async schedule(
    conversationId: ConversationId,
    input: { prompt: string; in_minutes?: number; at?: string },
    context: Context = BACKGROUND_CONTEXT,
  ) {
    if ((input.in_minutes === undefined) === (input.at === undefined))
      return { error: "Give exactly one of in_minutes or at" };

    const now = this.now();
    let at: number;

    if (input.at !== undefined) {
      const parsed = parseAt(input.at);

      if (parsed === undefined)
        return {
          error: "at must be an ISO 8601 time with an offset, e.g. 2026-01-02T09:00:00Z",
          now: iso(now),
        };
      at = parsed;
    } else at = now + (input.in_minutes ?? 0) * 60_000;

    if (at < now + 60_000) return { error: "Schedule at least 1 minute ahead", now: iso(now) };

    if (at > now + MAX_DELAY_MINUTES * 60_000)
      return { error: "Schedule at most 30 days ahead", now: iso(now) };

    const conversation = await this.harness.conversation(conversationId, context);

    if (!conversation) return { error: "Session not found" };

    return conversation.commit(async (tx) => {
      const state = await tx.doc(ScheduledPrompts, conversationId);

      if (Object.keys(state.pending).length >= MAX_SCHEDULED)
        return { error: `Scheduled prompt limit reached (${MAX_SCHEDULED} pending per session)` };

      const taskId = await tx.createTask(
        ScheduledPrompt,
        { prompt: input.prompt, at, createdAt: now },
        { ownership: { kind: "conversation" }, background: true },
      );

      state.pending[String(taskId)] = { taskId, at, createdAt: now, prompt: input.prompt };

      return { id: String(taskId), at: iso(at), now: iso(now) };
    }, context);
  }

  async list(conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT) {
    const state = await this.harness.snapshot(ScheduledPrompts, conversationId, context);

    return {
      now: iso(this.now()),
      scheduled: Object.entries(state?.pending ?? {})
        .map(([id, entry]) => ({ id, at: iso(entry.at), prompt: entry.prompt }))
        .sort((a, b) => a.at.localeCompare(b.at)),
    };
  }

  async cancel(conversationId: ConversationId, id: string, context: Context = BACKGROUND_CONTEXT) {
    const state = await this.harness.snapshot(ScheduledPrompts, conversationId, context);
    const entry = Object.hasOwn(state?.pending ?? {}, id) ? state?.pending[id] : undefined;

    if (!entry) return { error: "No pending scheduled prompt with that id in this session" };

    await this.harness.abortTask(entry.taskId, context);

    return { id, state: "cancelled" };
  }

  tools(): ToolRegistration[] {
    const reply = async (result: Promise<unknown>): Promise<ToolExecutionResult> => ({
      output: [{ type: "text", text: JSON.stringify(await result) }],
    });

    return [
      defineTool({
        name: "schedule_prompt",
        description:
          "Schedule a prompt to arrive in this same session later, as a new user message, e.g. when asked to do something in two hours or tomorrow at 9. Give exactly one of in_minutes (1–43200) or at (ISO 8601 with an offset or Z); the result reports the current time. Write a self-contained prompt: restate the request, repository, branch and constraints, because it runs as a fresh turn. After scheduling, end your turn and tell the user when it will run. Durable across restarts; up to 20 pending per session. Stopping the session cancels pending prompts. A delivered prompt can schedule its own continuation.",
        parameters: obj({
          prompt: str({ minLength: 1, maxLength: 32_768 }),
          in_minutes: opt(int({ minimum: 1, maximum: MAX_DELAY_MINUTES })),
          at: opt(
            str({ description: "ISO 8601 time with offset, e.g. 2026-01-02T09:00:00+10:00" }),
          ),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: (input, api, context) => reply(this.schedule(api.conversationId, input, context)),
      }),
      defineTool({
        name: "list_scheduled_prompts",
        description: "List this session's pending scheduled prompts with their ids and times.",
        parameters: obj({}),
        replay: "safe",
        execute: (_, api, context) => reply(this.list(api.conversationId, context)),
      }),
      defineTool({
        name: "cancel_scheduled_prompt",
        description: "Cancel one of this session's pending scheduled prompts by id.",
        parameters: obj({ id: str() }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: ({ id }, api, context) => reply(this.cancel(api.conversationId, id, context)),
      }),
    ];
  }
}
