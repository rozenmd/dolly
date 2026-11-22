import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineDocFamily,
  defineTask,
  type ConversationId,
  type ConversationRecord,
  type Harness,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { nextCronTime, parseCron, shortestInterval, validTimeZone } from "./cron";
import { MCP_NAME } from "./mcp";
import { SessionModel, ThinkingLevel } from "./models";
import type { IntakeAgent } from "./model-defaults";
import {
  ConversationWorkspace,
  READ_ONLY_TOOLS,
  WorkspaceInput,
  workspaceConfig,
} from "./workspace";

/**
 * Automations, after OpenSession's: a stored prompt plus a trigger. Each run is a fresh session
 * with no memory of earlier runs, started on a cron schedule, once at a set time, or by hand. Runs
 * are ordinary sessions: they show up in the sidebar and the owner can open, steer or stop them.
 *
 * Each automation is one Pi document holding its definition, its next fire and its recent runs,
 * and a small index lists every automation with its next fire. Every change (a save, a fire, a
 * run's session and delivery task, a deletion) touches both in one transaction, so a restart sees
 * an automation entirely before or entirely after a change: a fire is never lost or repeated.
 */

export const MAX_AUTOMATIONS = 50;
export const RUN_HISTORY = 20;

/** Each run starts a sandbox and a model turn, so schedules may not fire more often than this. */
export const MIN_INTERVAL_MINUTES = 10;

const SUMMARY_CHARS = 1_000;

const Name = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const Prompt = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32_768));
const Expression = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const TimeZone = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const At = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));

const McpServers = Schema.Array(Schema.String.check(Schema.isPattern(MCP_NAME))).check(
  Schema.isMaxLength(20),
);

const optionalFields = {
  /** Five-field cron expression; null clears it. */
  schedule: Schema.optional(Schema.NullOr(Expression)),
  /** IANA zone the schedule is read in; UTC when absent. */
  timeZone: Schema.optional(Schema.NullOr(TimeZone)),
  /** One run at this ISO 8601 time (with an offset), instead of a schedule; null clears it. */
  runAt: Schema.optional(Schema.NullOr(At)),
  enabled: Schema.optional(Schema.Boolean),
  /** Runs read code and comment, never change a repository (like automatic reviews). */
  readOnly: Schema.optional(Schema.Boolean),
  workspace: Schema.optional(Schema.NullOr(WorkspaceInput)),
  model: Schema.optional(Schema.NullOr(SessionModel)),
  thinkingLevel: Schema.optional(Schema.NullOr(ThinkingLevel)),
  /** MCP servers runs may call; none unless listed. */
  mcpServers: Schema.optional(McpServers),
};

export const NewAutomation = Schema.Struct({ name: Name, prompt: Prompt, ...optionalFields });

export const AutomationPatch = Schema.Struct({
  name: Schema.optional(Name),
  prompt: Schema.optional(Prompt),
  ...optionalFields,
}).check(
  Schema.makeFilter((patch) =>
    Object.values(patch).some((value) => value !== undefined)
      ? undefined
      : "Expected at least one field to change",
  ),
);

export type Automation = {
  id: string;
  name: string;
  prompt: string;
  schedule?: string;
  timeZone?: string;
  runAt?: number;
  enabled: boolean;
  readOnly: boolean;
  workspace?: { repository: string; ref?: string; networkHosts?: string[] };
  model?: string;
  thinkingLevel?: string;
  mcpServers: string[];
  createdAt: number;
  updatedAt: number;
};

export type Trigger = "schedule" | "manual";

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";

export type AutomationRun = {
  /** Identifies one fire: `schedule:<due time>` or `manual:<request id>`. */
  key: string;
  trigger: Trigger;
  at: number;
  status: RunStatus;
  conversationId?: ConversationId;
  taskId?: TaskId<null>;
  finishedAt?: number;
  /** The start of the run's final answer. */
  summary?: string;
  error?: string;
};

/** One automation's document: its definition and everything about when and how it ran. */
type State = {
  automation: Automation;
  /** Bumped by every save, so an edit built from an older definition commits nothing. */
  revision: number;
  /** The pending fire; always the one `automation` makes, as both are written together. */
  nextRunAt?: number;
  /** The due time of the latest scheduled or one-off fire handled, whatever its outcome. */
  lastFire?: number;
  /** When that fire was handled, which a late alarm makes later than its due time. */
  lastStart?: number;
  /** Newest first. */
  runs: AutomationRun[];
  /**
   * Admitted request keys (`manual:<id>`) and the session each started, kept for a day
   * whatever the run history shows, so a retried request returns its original run.
   */
  requests: Record<string, { at: number; conversationId?: ConversationId }>;
};

/** How long a request key keeps returning the run it started. */
export const REQUEST_RETENTION_MS = 86_400_000;

/** Checkpoint now and then, so a document is a recent base plus a few changes. */
const CHECKPOINT_EVERY = 32;

/** One automation, keyed by its ID; `state` is null only before its first save. */
export const AutomationDoc = defineDocFamily<{ state: State | null }, null>({
  kind: "app.automation",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ state: null }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= CHECKPOINT_EVERY,
});

/** Every automation's ID and pending fire: what listing and the alarm read. */
export const AutomationIndex = defineDoc<{ automations: Record<string, { nextRunAt?: number }> }>({
  kind: "app.automation-index",
  version: 1,
  scope: "session",
  initial: () => ({ automations: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= CHECKPOINT_EVERY,
});

/** What started a session as an automation run, inherited by sessions it spawns. */
export type AutomationProvenance = {
  automationId: string;
  name: string;
  trigger: Trigger;
  /** The only MCP servers the run may call. */
  mcpServers: string[];
};

export const AutomationRunDoc = defineDoc<{ run: AutomationProvenance | null }>({
  kind: "app.automation-run",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ run: null }),
  checkpointWhen: () => false,
});

/** Sessions an automation run spawns are held to the same limits as the run. */
export async function inheritAutomationRun(tx: Tx, conversation: ConversationRecord) {
  const parent = conversation.owner?.conversationId;

  if (parent === undefined) return;
  const run = (await tx.doc(AutomationRunDoc, parent)).run;

  if (run)
    (await tx.doc(AutomationRunDoc, conversation.id)).run = {
      ...run,
      mcpServers: [...run.mcpServers],
    };
}

/** Parse an absolute time; an explicit offset (or Z) is required so the zone is never guessed. */
function parseAt(at: string) {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at)) return undefined;
  const time = Date.parse(at);

  return Number.isNaN(time) ? undefined : time;
}

/**
 * The next fire after `now`. After a fire at `previous`, fires closer than the minimum interval
 * are skipped: validation samples a schedule, and daylight-saving changes can squeeze two wall
 * times closer together in real time than any sampled pair.
 */
export function nextRunAt(automation: Automation, now: number, previous?: number) {
  // Only recurring schedules are spaced: a one-off runs at the time it was given.
  if (previous !== undefined && automation.schedule !== undefined)
    return nextRunAt(automation, Math.max(now, previous + MIN_INTERVAL_MINUTES * 60_000 - 1));

  if (!automation.enabled) return undefined;

  if (automation.runAt !== undefined) return automation.runAt > now ? automation.runAt : undefined;

  if (!automation.schedule) return undefined;
  const cron = parseCron(automation.schedule);

  return "error" in cron ? undefined : nextCronTime(cron, now, automation.timeZone ?? "UTC");
}

/** Cross-field rules and normalization; returns the definition or why it is invalid. */
function validate(
  base: Automation,
  input: typeof AutomationPatch.Type | typeof NewAutomation.Type,
  now: number,
): Automation | { error: string } {
  const next: Automation = { ...base, updatedAt: now };

  if (input.name !== undefined) next.name = input.name;

  if (input.prompt !== undefined) next.prompt = input.prompt;

  if (input.enabled !== undefined) next.enabled = input.enabled;

  if (input.readOnly !== undefined) next.readOnly = input.readOnly;

  if (input.mcpServers !== undefined) next.mcpServers = [...new Set(input.mcpServers)];

  const assign = <K extends "schedule" | "timeZone" | "model" | "thinkingLevel">(
    key: K,
    value: Automation[K] | null | undefined,
  ) => {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  };

  assign("schedule", input.schedule);
  assign("timeZone", input.timeZone);
  assign("model", input.model);
  assign("thinkingLevel", input.thinkingLevel);

  if (input.workspace === null) delete next.workspace;
  else if (input.workspace !== undefined) {
    // Network hosts belong to a repository: a workspace that leaves them out keeps the ones held
    // now for the same repository (`[]` clears them), and a new repository starts with none.
    const hosts =
      input.workspace.networkHosts ??
      (base.workspace?.repository === input.workspace.repository
        ? base.workspace.networkHosts
        : undefined);

    next.workspace = {
      repository: input.workspace.repository,
      ...(input.workspace.ref !== undefined && { ref: input.workspace.ref }),
      ...(hosts !== undefined && { networkHosts: [...hosts] }),
    };
  }

  if (input.runAt === null) delete next.runAt;
  else if (input.runAt !== undefined) {
    const at = parseAt(input.runAt);

    if (at === undefined)
      return { error: "runAt must be an ISO 8601 time with an offset, e.g. 2026-01-02T09:00:00Z" };

    if (at < now + 60_000) return { error: "runAt must be at least 1 minute ahead" };
    next.runAt = at;
  }

  if (next.schedule !== undefined && next.runAt !== undefined)
    return { error: "Give a schedule or a runAt time, not both" };

  if (next.timeZone !== undefined && !validTimeZone(next.timeZone))
    return { error: `Unknown time zone "${next.timeZone}"; use an IANA name like Europe/Paris` };

  if (next.schedule !== undefined) {
    const cron = parseCron(next.schedule);

    if ("error" in cron) return { error: cron.error };
    const zone = next.timeZone ?? "UTC";

    if (nextCronTime(cron, now, zone) === undefined) return { error: "This schedule never fires" };
    const shortest = shortestInterval(cron, now, zone);

    if (shortest !== undefined && shortest < MIN_INTERVAL_MINUTES * 60_000)
      return {
        error: `Schedules may fire at most every ${MIN_INTERVAL_MINUTES} minutes: each run starts a sandbox and a model turn`,
      };
  }

  if (next.readOnly && !next.workspace)
    return { error: "A read-only automation needs a repository to read" };

  if (next.readOnly && next.mcpServers.length)
    return { error: "Read-only automations cannot use MCP servers" };

  return next;
}

/** The prompt a run's session receives: the owner's prompt plus what kind of run this is. */
export function runPrompt(automation: Automation, trigger: Trigger, at: number) {
  const how = trigger === "schedule" ? "scheduled run" : "manual run";

  return `${automation.prompt}\n\n---\n[Automation "${automation.name}", ${how} at ${new Date(at).toISOString()}] This is a fresh session with no memory of earlier runs, and nobody is watching it live: work without asking questions, and finish with a short summary of what you did and found.`;
}

export type RunInput = {
  automationId: string;
  key: string;
  content: string;
};

/** Settle one run; a deleted automation or a pruned run is left alone. */
async function settle(
  tx: Tx,
  automationId: string,
  key: string,
  outcome: Pick<AutomationRun, "status" | "summary" | "error">,
  at: number,
) {
  // The index first: reading a deleted automation's document would create it again.
  if (!Object.hasOwn((await tx.doc(AutomationIndex)).automations, automationId)) return;
  const state = (await tx.doc(AutomationDoc, automationId, null)).state;
  const run = state?.runs.find((entry) => entry.key === key);

  if (!run || run.status !== "running") return;
  run.status = outcome.status;
  run.finishedAt = at;

  if (outcome.summary) run.summary = outcome.summary;

  if (outcome.error) run.error = outcome.error;
}

/** Submits a run's prompt in its own session, then records how the run ended. */
export const AutomationRunTask = defineTask<RunInput, { phase: "deliver" }, null>({
  name: "app.automation-run",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const conversation = await runtime.conversation(task.conversationId, context);

      if (!conversation) throw new Error("Automation conversation missing");

      const submission = await conversation.submit(
        {
          type: "input",
          content: task.input.content,
          requestId: `automation:${task.input.automationId}:${task.input.key}`,
          whenBusy: "followUp",
        },
        context,
      );

      const settled = await submission.wait(context);

      await runtime.commit(async (tx) => {
        let outcome: Pick<AutomationRun, "status" | "summary" | "error">;

        if (settled.status === "unanswered" || settled.type !== "input")
          outcome = { status: "failed", error: "The run ended without an answer" };
        else {
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const messages = (entry?.model ?? []).filter((message) => message.role === "assistant");

          const text = messages
            .flatMap((message) =>
              message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
            )
            .join("\n")
            .trim();

          const last = messages.at(-1);

          outcome =
            last?.stopReason === "error" || last?.stopReason === "aborted"
              ? {
                  status: "failed",
                  error:
                    last.stopReason === "aborted"
                      ? "Stopped"
                      : (last.errorMessage ?? "Model request failed").slice(0, SUMMARY_CHARS),
                }
              : { status: "succeeded", summary: text.slice(0, SUMMARY_CHARS) };
        }

        await settle(tx, task.input.automationId, task.input.key, outcome, runtime.now());

        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: (task, runtime, context) =>
    runtime.commit(async (tx) => {
      await settle(
        tx,
        task.input.automationId,
        task.input.key,
        { status: "failed", error: "Stopped" },
        runtime.now(),
      );

      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
});

/**
 * Add a run to the history, newest first. Only finished runs are pruned: a live run stays
 * findable however many skips or other runs follow it, so overlap checks never lose it.
 */
function record(state: State, run: AutomationRun) {
  state.runs.unshift(run);

  for (let index = state.runs.length - 1; state.runs.length > RUN_HISTORY && index >= 0; index--)
    if (state.runs[index]?.status !== "running") state.runs.splice(index, 1);
}

/** Remember a request key and its session; keys older than the retention window are dropped. */
function remember(state: State, key: string, at: number, conversationId?: ConversationId) {
  for (const [old, seen] of Object.entries(state.requests))
    if (seen.at < at - REQUEST_RETENTION_MS) delete state.requests[old];

  state.requests[key] = { at, ...(conversationId !== undefined && { conversationId }) };
}

type Index = { automations: Record<string, { nextRunAt?: number }> };

/** Set an automation's pending fire in its document and in the index, together. */
function setNext(index: Index, state: State, at: number | undefined) {
  const listed = index.automations[state.automation.id];

  if (at === undefined) {
    delete state.nextRunAt;

    if (listed) delete listed.nextRunAt;
  } else {
    state.nextRunAt = at;

    if (listed) listed.nextRunAt = at;
  }
}

/**
 * The fire pending once `next` is saved over `previous` (absent for a new automation), for a
 * request made at `now`:
 * - a one-off fires at its time if that is still ahead, or if it was already pending (only its
 *   details changed while its alarm is late), but never again once it has fired;
 * - an overdue cron fire the schedule still makes is kept for its late alarm;
 * - otherwise the schedule's next fire, spaced from the last scheduled start.
 */
function pendingAfterSave(next: Automation, previous: Readonly<State> | undefined, now: number) {
  if (!next.enabled) return undefined;
  const pending = previous?.nextRunAt;

  if (next.runAt !== undefined) {
    if (previous?.lastFire === next.runAt) return undefined;

    return next.runAt > now || pending === next.runAt ? next.runAt : undefined;
  }

  if (
    pending !== undefined &&
    pending <= now &&
    next.schedule !== undefined &&
    nextRunAt(next, pending - 1) === pending
  )
    return pending;

  return nextRunAt(next, now, previous?.lastStart);
}

type Admission =
  | { status: "started"; conversationId: ConversationId }
  | { status: "duplicate"; conversationId?: ConversationId }
  | { status: "busy"; conversationId?: ConversationId }
  | { status: "stale" };

/** Whether the run recorded as running still has a live delivery task. */
async function stillRunning(tx: Tx, run: AutomationRun) {
  if (run.taskId === undefined) return false;
  const task = await tx.task(run.taskId);

  return (
    task !== undefined && task.state.status !== "terminal" && task.state.status !== "completing"
  );
}

/**
 * Start one run in a fresh session, in one commit with the automation's document: a repeated
 * fire (the same `key`, or a scheduled fire whose time has moved on) starts nothing, and nor
 * does one whose definition was saved again since `revision` was read, as its model was picked
 * for the older one (its caller retries). A run never overlaps another of the same automation;
 * a scheduled fire then records a skip.
 */
async function admit(
  harness: Harness,
  input: {
    id: string;
    revision: number;
    agent: IntakeAgent;
    trigger: Trigger;
    key: string;
    at: number;
    /** For a scheduled fire: the due time it is for. */
    due?: number;
  },
): Promise<Admission> {
  const { id, revision, agent, trigger, key, at, due } = input;

  return harness.commit(async (tx) => {
    const index = await tx.doc(AutomationIndex);

    if (!Object.hasOwn(index.automations, id)) return { status: "stale" };
    const state = (await tx.doc(AutomationDoc, id, null)).state;

    if (!state) return { status: "stale" };

    const duplicate =
      state.runs.find((run) => run.key === key) ??
      (Object.hasOwn(state.requests, key) ? state.requests[key] : undefined);

    if (duplicate) return { status: "duplicate", conversationId: duplicate.conversationId };

    if (state.revision !== revision) return { status: "stale" };

    const { automation } = state;

    if (due !== undefined) {
      if (state.nextRunAt !== due) return { status: "stale" };
      // The next fire is spaced from now, when this one is handled, not from when it was due.
      setNext(index, state, nextRunAt(automation, at, at));
      state.lastFire = due;
      state.lastStart = at;
    }

    const live = state.runs.filter((run) => run.status === "running");

    for (const run of live)
      if (await stillRunning(tx, run)) {
        if (due !== undefined)
          record(state, { key, trigger, at, status: "skipped", error: "Still running" });

        return { status: "busy", conversationId: run.conversationId };
      } else {
        run.status = "failed";
        run.error = "The run ended without reporting back";
      }

    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, agent);

    // An allowlist, so tools added later are not offered to a read-only run.
    if (automation.readOnly) (await tx.doc(AgentDoc, conversation.id)).tools = [...READ_ONLY_TOOLS];

    if (automation.workspace)
      (await tx.doc(ConversationWorkspace, conversation.id)).config = workspaceConfig(
        automation.workspace,
        String(conversation.id),
        { readOnly: automation.readOnly },
      );

    (await tx.doc(AutomationRunDoc, conversation.id)).run = {
      automationId: id,
      name: automation.name,
      trigger,
      mcpServers: [...automation.mcpServers],
    };

    const taskId = await tx.createTask(
      AutomationRunTask,
      { automationId: id, key, content: runPrompt(automation, trigger, at) },
      { conversationId: conversation.id, ownership: { kind: "conversation" }, background: true },
    );

    record(state, { key, trigger, at, status: "running", conversationId: conversation.id, taskId });

    // Scheduled fires are deduplicated by their due time instead.
    if (due === undefined) remember(state, key, at, conversation.id);

    return { status: "started", conversationId: conversation.id };
  }, BACKGROUND_CONTEXT);
}

/** What the API returns: the definition, its next fire and its recent runs by session ID. */
function view({ automation, nextRunAt: next, runs }: Readonly<State>) {
  return {
    ...automation,
    ...(next !== undefined && { nextRunAt: next }),
    runs: runs.map(({ taskId: _task, conversationId, key: _key, ...run }) => ({
      ...run,
      ...(conversationId !== undefined && { sessionId: String(conversationId) }),
    })),
  };
}

/** A JSON copy of a value read from a transaction's documents. */
function detach<T>(value: T): T {
  // SAFETY: JSON round-trips keep the shape of the JSON-only values Pi documents hold.
  return JSON.parse(JSON.stringify(value)) as T;
}

export type AutomationHost = {
  harness: () => Harness;
  /** The model a run starts on, or why it cannot run (no subscription connected). */
  agent: (automation: Automation) => Promise<IntakeAgent | { error: string }>;
  /** After a run's session is created: title it and tell sidebars. */
  started: (conversationId: ConversationId, automation: Automation) => Promise<void>;
  /**
   * Have the alarm go off by `at`, before the change that needs it commits: a restart right
   * after the commit then still finds the alarm. An early alarm finds nothing due and re-arms.
   * Every alarm change keeps `at` until the returned release is called, after the save re-arms.
   */
  prearm: (at: number) => Promise<() => void>;
  /** The earliest pending fire changed; re-arm the alarm to it. */
  rearm: () => Promise<void>;
  now: () => number;
};

/** Reads that race a concurrent change are retried this many times. */
const ATTEMPTS = 5;

export class Automations {
  constructor(private readonly host: AutomationHost) {}

  private async index() {
    return (
      (await this.host.harness().snapshot(AutomationIndex, BACKGROUND_CONTEXT))?.automations ?? {}
    );
  }

  private async state(id: string, context: Context = BACKGROUND_CONTEXT) {
    // The index first: reading a deleted automation's document would not find it anyway.
    if (!Object.hasOwn(await this.index(), id)) return undefined;

    return (await this.host.harness().snapshot(AutomationDoc, id, context))?.state ?? undefined;
  }

  /**
   * Save the automation `build` makes from the current definition (none for a new one), with
   * its pending fire, in one commit. Built from a read, it commits only if no other save changed
   * the definition since, and if a run in the meantime didn't change the pending fire; otherwise
   * it is built again from a fresh read. Runs, request keys and fire history are kept.
   */
  private async save(
    id: string,
    create: boolean,
    build: (current: Automation | undefined, now: number) => Automation | { error: string },
  ) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const now = this.host.now();
      const previous = await this.state(id);

      if (!create && !previous) return undefined;
      const automation = build(previous?.automation, now);

      if ("error" in automation) return automation;
      const pending = pendingAfterSave(automation, previous, now);
      const revision = previous?.revision ?? 0;

      // Armed before the commit: a restart right after it still finds the alarm.
      const release = pending === undefined ? undefined : await this.host.prearm(pending);

      try {
        const outcome = await this.host.harness().commit(async (tx) => {
          const index = await tx.doc(AutomationIndex);
          const listed = Object.hasOwn(index.automations, id);

          if (create && Object.keys(index.automations).length >= MAX_AUTOMATIONS) return "full";

          if (listed !== !create) return "changed";
          const doc = await tx.doc(AutomationDoc, id, null);

          // A run committed since the read may have moved the pending fire: build again.
          if (
            (doc.state?.revision ?? 0) !== revision ||
            pendingAfterSave(automation, doc.state ?? undefined, now) !== pending
          )
            return "changed";

          if (doc.state) {
            doc.state.automation = automation;
            doc.state.revision = revision + 1;
          } else doc.state = { automation, revision: 1, runs: [], requests: {} };
          index.automations[id] = {};
          setNext(index, doc.state, pending);

          // A plain copy: the document's draft can't be read once the commit settles.
          return { saved: detach(view(doc.state)) };
        }, BACKGROUND_CONTEXT);

        if (outcome === "full") return { error: `Automation limit reached (${MAX_AUTOMATIONS})` };

        if (outcome !== "changed") return outcome.saved;
      } finally {
        // Re-armed from the index before the fire is released, so no alarm change drops it.
        try {
          await this.host.rearm();
        } finally {
          release?.();
        }
      }
    }

    return { error: "The automation kept changing; try again" };
  }

  async list() {
    const states = await Promise.all(Object.keys(await this.index()).map((id) => this.state(id)));

    return states
      .flatMap((state) => (state ? [view(state)] : []))
      .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
  }

  async read(id: string) {
    const state = await this.state(id);

    return state && view(state);
  }

  async create(input: typeof NewAutomation.Type) {
    const id = crypto.randomUUID();

    const saved = await this.save(id, true, (_current, now) =>
      validate(
        {
          id,
          name: input.name,
          prompt: input.prompt,
          enabled: true,
          readOnly: false,
          mcpServers: [],
          createdAt: now,
          updatedAt: now,
        },
        input,
        now,
      ),
    );

    return saved ?? { error: "Automation not saved" };
  }

  update(id: string, patch: typeof AutomationPatch.Type) {
    return this.save(id, false, (current, now) =>
      current ? validate(current, patch, now) : { error: "Automation not found" },
    );
  }

  async remove(id: string) {
    const removed = await this.host.harness().commit(async (tx) => {
      const index = await tx.doc(AutomationIndex);

      if (!Object.hasOwn(index.automations, id)) return false;
      delete index.automations[id];
      await tx.retireDoc(AutomationDoc, id);

      return true;
    }, BACKGROUND_CONTEXT);

    if (!removed) return undefined;
    await this.host.rearm();

    return { deleted: true };
  }

  /** Run now, by hand. Retrying the same request returns the same run. */
  async run(id: string, requestId: string) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const state = await this.state(id);

      if (!state) return undefined;
      const agent = await this.host.agent(state.automation);

      if ("error" in agent) return agent;

      const admission = await admit(this.host.harness(), {
        id,
        revision: state.revision,
        agent,
        trigger: "manual",
        key: `manual:${requestId}`,
        at: this.host.now(),
      });

      if (admission.status === "stale") continue;

      if (admission.status === "busy")
        return {
          error: "This automation is already running",
          ...(admission.conversationId !== undefined && {
            sessionId: String(admission.conversationId),
          }),
        };

      if (admission.status === "started")
        await this.host.started(admission.conversationId, state.automation);

      return {
        ...(admission.conversationId !== undefined && {
          sessionId: String(admission.conversationId),
        }),
        duplicate: admission.status === "duplicate",
      };
    }

    return { error: "Run not started; try again" };
  }

  /** The earliest pending fire of any automation. */
  async nextWake() {
    const times = Object.values(await this.index()).flatMap((entry) =>
      entry.nextRunAt === undefined ? [] : [entry.nextRunAt],
    );

    return times.length ? Math.min(...times) : undefined;
  }

  /** Fire every automation that is due. A run that cannot start is recorded as failed. */
  async fireDue() {
    const now = this.host.now();

    for (const [id, { nextRunAt: due }] of Object.entries(await this.index()))
      if (due !== undefined && due <= now) await this.fire(id, due, now);
  }

  private async fire(id: string, due: number, now: number) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const state = await this.state(id);

      if (state?.nextRunAt !== due) return;
      const agent = await this.host.agent(state.automation);

      if ("error" in agent) {
        await this.host.harness().commit(async (tx) => {
          const index = await tx.doc(AutomationIndex);

          if (!Object.hasOwn(index.automations, id)) return;
          const current = (await tx.doc(AutomationDoc, id, null)).state;

          if (current?.nextRunAt !== due) return;
          setNext(index, current, nextRunAt(current.automation, now, now));
          current.lastFire = due;
          current.lastStart = now;
          record(current, {
            key: `schedule:${due}`,
            trigger: "schedule",
            at: now,
            status: "failed",
            finishedAt: now,
            error: agent.error,
          });
        }, BACKGROUND_CONTEXT);

        return;
      }

      const admission = await admit(this.host.harness(), {
        id,
        revision: state.revision,
        agent,
        trigger: "schedule",
        key: `schedule:${due}`,
        at: now,
        due,
      });

      if (admission.status === "stale") continue;

      if (admission.status === "started")
        await this.host.started(admission.conversationId, state.automation);

      return;
    }
  }
}
