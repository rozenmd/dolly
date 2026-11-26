import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  configure,
  defineDoc,
  defineTask,
  defineTool,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type Harness,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ConversationWorkspace,
  READ_ONLY_TOOLS,
  isReadOnly,
  workspaceConfig,
  type WorkspaceState,
} from "./workspace";
import { SessionModel, modelProvider } from "./models";
import { attempt } from "./operations";
import {
  sessionNoticeMessage,
  workerFailureMessage,
  workerReportMessage,
} from "./child-report-message";
import {
  buildChildSessionPrompt,
  evidenceFromTranscript,
  formatHandoffEvidence,
  type ChildCheckout,
  type EvidenceState,
  type HandoffEvidence,
} from "./child-report";

/**
 * Child sessions: spawn_task, send_to_session, task_status and cancel_task.
 *
 * A session delegates a self-contained task with spawn_task and gets the child's id back at once;
 * the child runs in the background and its parent is never held open waiting. The child is told
 * to report back as its last action with send_to_session, which attaches facts computed from its
 * transcript (child-report.ts). The parent can end its turn and wait with wait_for kind
 * session_turn (ci-wait.ts), look in with task_status, follow up with send_to_session and stop it
 * with cancel_task. A worker whose run dies can't report, so the server tells its parent once.
 */

/** A session at this spawn depth may not spawn further: a spawned child may spawn one grandchild. */
export const MAX_SPAWN_DEPTH = 2;

/** Children working at once. Each is a model run and often a sandbox, so this is bounded. */
export const MAX_WORKING = 8;

/** Children one session may start over its lifetime. */
export const MAX_CHILDREN = 32;

/** A worker that reported this recently doesn't need the server repeating it. */
const REPORT_GRACE_MS = 2 * 60_000;

/** Ceiling on failure notices per worker, so a session failing in a loop can't spam its parent. */
const BEACON_THROTTLE_MS = 10 * 60_000;

/** How much of a transcript one evidence read scans, newest first. */
const EVIDENCE_SCAN_ENTRIES = 2_000;

export type ChildMode = "ask" | "code" | "scratch";

const WORKING_LIMIT = `${MAX_WORKING} child sessions are already working. Wait for one with wait_for kind session_turn, or stop one with cancel_task.`;

/** Pi's ownership edges are authoritative for ancestry and recursive cancellation. */
export const SessionIndex = defineDoc<{ ids: Record<string, ConversationId> }>({
  kind: "app.session-index",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {} }),
  checkpointWhen: () => false,
});

type Child = {
  id: ConversationId;
  model: string;
  /** The task as the parent wrote it, without the worker briefing. */
  content: string;
  /** Absent for children started before modes existed: they had their own checkout. */
  mode?: ChildMode;
  createdAt?: number;
  /** When the child last reported to this parent with send_to_session. */
  lastReportAt?: number;
  /** When the server last told this parent the child's run died. */
  notifiedAt?: number;
};

const Children = defineDoc<{ children: Record<string, Child> }>({
  kind: "app.children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ children: {} }),
  checkpointWhen: () => false,
});

type ChildrenState = { children: Record<string, Child> };

// A completed background anchor retains the child ownership edge without keeping the parent busy.
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "app.child-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const DELIVERY = "app.child-delivery";

/**
 * Admits a child's first message. A conversation created in a commit can't take a submission in
 * that same commit (it must come before the commit's first table write), so this background task
 * admits it in its own. Deliveries from before reports went through send_to_session waited for the
 * answer here; rerun after an upgrade, they are admitted once more under the same request id.
 */
const Delivery = defineTask<
  { childId: ConversationId; content: string },
  { phase: "deliver" },
  { status: "delivered" }
>({
  name: DELIVERY,
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const child = await runtime.conversation(task.input.childId, context);

      if (!child) throw new Error("Child conversation missing");

      await runtime.commit(async (tx) => {
        await child.submit(tx, {
          type: "input",
          content: task.input.content,
          requestId: `delivery:${task.id}`,
          whenBusy: "steer",
        });

        return {
          status: "terminal",
          outcome: { status: "completed", result: { status: "delivered" } },
        };
      }, context);
    },
  },
  abort: (_, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const coordinationTasks = [Anchor, Delivery];

export async function indexSession(tx: Tx, id: ConversationId) {
  (await tx.doc(SessionIndex)).ids[id] = id;
}

const findChild = (state: ChildrenState | undefined, id: ConversationId | string) =>
  Object.values(state?.children ?? {}).find((child) => String(child.id) === String(id));

const title = (content: string) => content.trim().split("\n")[0]?.slice(0, 80) ?? "";

const LIVE = ["pending", "running", "waiting", "sleeping", "completing"] as const;

/**
 * Whether a conversation is working: a live run, or a first message still being admitted. Read
 * from task state, not a cached summary, so a prompt that is queued but not yet started counts.
 * A task read, so call it before the commit's first table write.
 */
export async function isWorking(tx: Tx, id: ConversationId) {
  for (const status of LIVE) {
    const run = await tx.scanTasks({ conversationId: id, status, background: false }, 1);

    if (run.items.length) return true;

    const delivery = await tx.scanTasks({ conversationId: id, status, kind: DELIVERY }, 1);

    if (delivery.items.length) return true;
  }

  return false;
}

/**
 * A session and every session under it, from each one's own Children doc. A session whose turn
 * ended while a child it spawned is still running is still working on its task.
 */
export async function subtreeOf(harness: Harness, id: ConversationId, context: Context) {
  const ids = [id];

  for (let index = 0; index < ids.length; index++) {
    const state = await harness.snapshot(Children, ids[index], context);

    for (const child of Object.values(state?.children ?? {})) ids.push(child.id);
  }

  return ids;
}

/** The first of `ids` that is working, if any. Task reads: before the commit's first table write. */
export async function workingIn(tx: Tx, ids: readonly ConversationId[]) {
  for (const id of ids) if (await isWorking(tx, id)) return id;

  return undefined;
}

/** The first message still being admitted to a conversation, if any. */
export async function pendingDelivery(tx: Tx, id: ConversationId) {
  for (const status of LIVE) {
    const delivery = await tx.scanTasks({ conversationId: id, status, kind: DELIVERY }, 1);

    if (delivery.items[0]) return delivery.items[0].id;
  }

  return undefined;
}

const parentOf = async (tx: Tx, id: ConversationId) =>
  (await tx.conversation(id))?.owner?.conversationId;

/** Spawn hops from a session the owner started: 0 for a root session. */
async function depthOf(tx: Tx, id: ConversationId) {
  let depth = 0;
  let record = await tx.conversation(id);

  while (record?.owner) {
    depth++;
    record = await tx.conversation(record.owner.conversationId);
  }

  return depth;
}

async function readTranscript(
  harness: Harness,
  id: ConversationId,
  limit: number,
  context: Context,
) {
  const conversation = await harness.conversation(id, context);

  if (!conversation) return [];
  const items: EntryRecord[] = [];
  let cursor: Cursor | undefined;

  do {
    const page = await conversation.entries({ order: "descending" }, 200, cursor, context);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor && items.length < limit);

  return items.slice(0, limit).reverse();
}

const iso = (at: number) => new Date(at).toISOString();

function relTime(at: number, now: number) {
  const secs = Math.round((now - at) / 1000);

  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);

  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);

  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

const TEXT_LIMIT = 280;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);

const blockText = (content: readonly { type: string; text?: string }[]) =>
  content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join(" ");

/** The newest `lines` transcript items, one per line: who, whether it failed, and its text. */
export function transcriptTail(entries: readonly EntryRecord[], lines: number) {
  const items: string[] = [];

  for (const message of entries.flatMap((entry) => entry.model ?? [])) {
    if (message.role === "user")
      items.push(
        `• user: ${oneLine(Schema.is(Schema.String)(message.content) ? message.content : blockText(message.content))}`,
      );

    if (message.role === "assistant")
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim())
          items.push(`• assistant: ${oneLine(block.text)}`);

        if (block.type === "toolCall")
          items.push(`• tool:${block.name}: ${oneLine(JSON.stringify(block.arguments))}`);
      }

    // An errored tool call rendering identically to a successful one is misleading in a status view.
    if (message.role === "toolResult")
      items.push(
        `• tool_result${message.isError ? " ✗" : ""}: ${oneLine(blockText(message.content))}`,
      );
  }

  return items.length ? items.slice(-lines).join("\n") : "_(no transcript yet)_";
}

export type SpawnInput = {
  prompt: string;
  requestId: string;
  model?: string;
  repo?: string;
  branch?: string;
  isolatedWorktree?: boolean;
  mode?: ChildMode;
};

export type SpawnResult =
  | { ok: true; taskId: string; model: string; url: string; createdAt: number }
  | { ok: false; error: string };

export type CoordinationDeps = {
  /** Resolve a repository name the GitHub App can reach to its canonical owner/name, or throw. */
  repository?: (name: string, context: Context) => Promise<string>;
  /** Whether a session may reach sessions outside its own family: those started from the web app. */
  reachesAll?: (id: ConversationId) => Promise<boolean>;
  /** A session's link in the web app. */
  link?: (id: string) => Promise<string>;
  /** A session's title, as the sidebar shows it. */
  title?: (id: ConversationId) => Promise<string | undefined>;
  /** The conversation a web app session's public id names, as list_sessions reports it. */
  alias?: (id: string) => Promise<ConversationId | undefined>;
  now?: () => number;
};

const branchName = (branch: string) =>
  /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$)[\w./-]{1,200}$/.test(branch);

export class Coordination {
  constructor(
    private readonly getHarness: () => Harness,
    private readonly deps: CoordinationDeps = {},
  ) {}

  private get harness() {
    return this.getHarness();
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Each direct child of `parent` with the sessions under it, keyed by child id. */
  private async subtrees(parent: ConversationId | undefined, context: Context) {
    const subtrees = new Map<string, ConversationId[]>();

    if (parent === undefined) return subtrees;
    const state = await this.harness.snapshot(Children, parent, context);

    for (const child of Object.values(state?.children ?? {}))
      subtrees.set(String(child.id), await subtreeOf(this.harness, child.id, context));

    return subtrees;
  }

  /** Whether a session or any session under it is working. */
  private async subtreeWorking(id: ConversationId, context: Context) {
    const ids = await subtreeOf(this.harness, id, context);

    return (await this.harness.commit((tx) => workingIn(tx, ids), context)) !== undefined;
  }

  private async link(id: string) {
    return this.deps.link ? await this.deps.link(id) : `/session/${encodeURIComponent(id)}`;
  }

  resolve = Effect.fn("Coordination.resolve")((id: string) =>
    attempt("session.index", () => this.harness.snapshot(SessionIndex, BACKGROUND_CONTEXT)).pipe(
      Effect.map((index) => (Object.hasOwn(index?.ids ?? {}, id) ? index?.ids[id] : undefined)),
    ),
  );

  /**
   * A session `caller` may address: its own children and parent always, any other indexed
   * session only when it is allowed to reach every session.
   */
  private async reach(caller: ConversationId, id: string, context: Context) {
    const index = await this.harness.snapshot(SessionIndex, context);

    const indexed = (key: string) =>
      Object.hasOwn(index?.ids ?? {}, key) ? index?.ids[key] : undefined;

    const alias = await this.deps.alias?.(id);
    const target = indexed(id) ?? (alias === undefined ? undefined : indexed(String(alias)));

    if (target === undefined)
      return { ok: false as const, error: `No task/session with id \`${id}\`.` };

    const [state, parent] = await Promise.all([
      this.harness.snapshot(Children, caller, context),
      this.harness.commit((tx) => parentOf(tx, caller), context),
    ]);

    const child = findChild(state, target);

    if (child) return { ok: true as const, target, child, parent: false };

    if (parent !== undefined && String(parent) === String(target))
      return { ok: true as const, target, parent: true };

    // A read-only session (a reviewer, or a worker under one) stays within its own family: it
    // must not steer a writable session it didn't start.
    if (
      String(target) !== String(caller) &&
      !isReadOnly(await this.harness.snapshot(ConversationWorkspace, caller, context)) &&
      (await this.deps.reachesAll?.(caller))
    )
      return { ok: true as const, target, parent: false };

    return {
      ok: false as const,
      error: `\`${id}\` is not a task this session spawned or its parent.`,
    };
  }

  /** The session `caller` may watch or read by `id`: task_status's rule, for session_turn waits. */
  watchable = async (caller: ConversationId, id: string, context: Context) => {
    const reached = await this.reach(caller, id, context);

    return reached.ok ? { target: reached.target } : { error: reached.error };
  };

  /** The title of a session as its parent knows it: its task's first line. */
  childTitle = async (id: ConversationId) => {
    const parent = await this.harness.commit((tx) => parentOf(tx, id), BACKGROUND_CONTEXT);

    if (parent === undefined) return undefined;

    const record = findChild(await this.harness.snapshot(Children, parent, BACKGROUND_CONTEXT), id);

    return record ? title(record.content) : undefined;
  };

  spawn = Effect.fn("Coordination.spawn")(function* (
    this: Coordination,
    parent: ConversationId,
    input: SpawnInput,
    context = BACKGROUND_CONTEXT,
  ) {
    if (!input.prompt.trim())
      return { ok: false, error: "Need a prompt to spawn a task." } satisfies SpawnResult;

    const mode = input.mode ?? "code";
    const branch = input.branch?.trim();

    if (branch !== undefined && !branchName(branch))
      return {
        ok: false,
        error: `\`${branch}\` is not a valid branch name.`,
      } satisfies SpawnResult;

    const conversation = yield* attempt("parent.open", () =>
      this.harness.conversation(parent, context),
    );

    if (!conversation) return { ok: false, error: "Session not found" } satisfies SpawnResult;
    const agent = yield* attempt("parent.model", () => conversation.agent(context));

    const model = yield* Schema.decodeUnknownEffect(SessionModel)(
      input.model ?? agent.model?.modelId,
    ).pipe(Effect.orDie);

    const parentWorkspace = yield* attempt("parent.workspace", () =>
      this.harness.snapshot(ConversationWorkspace, parent, context),
    );

    // A repository other than the parent's must be one the GitHub App can reach, as with checkout.
    const requested = input.repo?.trim();

    const sameRepository =
      !requested || requested.toLowerCase() === parentWorkspace?.config?.repository.toLowerCase();

    let repository = sameRepository ? parentWorkspace?.config?.repository : requested;

    if (!sameRepository && requested) {
      const resolve = this.deps.repository;

      if (!resolve)
        return {
          ok: false,
          error: "This session can't start children in another repository.",
        } satisfies SpawnResult;

      const resolved = yield* Effect.tryPromise(() => resolve(requested, context)).pipe(
        Effect.map((name) => ({ name })),
        Effect.catch((error) =>
          Effect.succeed({ error: error instanceof Error ? error.message : String(error) }),
        ),
      );

      if ("error" in resolved)
        return {
          ok: false,
          error: `Could not use ${requested}: ${resolved.error}`,
        } satisfies SpawnResult;

      repository = resolved.name;
    }

    const now = this.now();
    const subtrees = yield* attempt("children.subtrees", () => this.subtrees(parent, context));

    const created = yield* attempt("child.create", () =>
      conversation.commit(async (tx): Promise<SpawnResult> => {
        const state = await tx.doc(Children, parent);
        const key = input.requestId;

        if (Object.hasOwn(state.children, key)) {
          const existing = state.children[key];

          return existing.content === input.prompt && existing.model === model
            ? {
                ok: true,
                taskId: String(existing.id),
                model: existing.model,
                url: "",
                createdAt: existing.createdAt ?? now,
              }
            : { ok: false, error: "requestId already used with different content or model" };
        }

        const depth = await depthOf(tx, parent);

        if (depth >= MAX_SPAWN_DEPTH)
          return {
            ok: false,
            error: `spawn_task refused: this session is already ${depth} spawn hops from a human-created session (max ${MAX_SPAWN_DEPTH}). Do the work here, or report back to your parent instead of delegating further.`,
          };

        if (Object.keys(state.children).length >= MAX_CHILDREN)
          return { ok: false, error: `Child limit reached (${MAX_CHILDREN} per session)` };

        // Task reads come before the commit's first table write.
        let working = 0;

        for (const child of Object.values(state.children))
          if (await workingIn(tx, subtrees.get(String(child.id)) ?? [child.id])) working++;

        if (working >= MAX_WORKING) return { ok: false, error: WORKING_LIMIT };

        const anchor = await tx.createTask(Anchor, null, {
          ownership: { kind: "conversation" },
          background: true,
        });

        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, {
          model: { provider: modelProvider(model), modelId: model },
        });

        const { workspace, checkout } = childWorkspace({
          parent: parentWorkspace,
          parentId: String(parent),
          childId: String(child.id),
          mode,
          repository,
          sameRepository,
          ...(branch !== undefined && { branch }),
          isolated: input.isolatedWorktree === true,
        });

        if (workspace) Object.assign(await tx.doc(ConversationWorkspace, child.id), workspace);

        // A read-only parent's children get its tool allowlist too, plus send_to_session so they
        // can report back as their briefing says; it only delivers messages, never writes.
        if (parentWorkspace?.config?.readOnly)
          (await tx.doc(AgentDoc, child.id)).tools = [...READ_ONLY_TOOLS, "send_to_session"];

        await tx.createTask(
          Delivery,
          {
            childId: child.id,
            content: buildChildSessionPrompt({
              prompt: input.prompt,
              parentSessionId: String(parent),
              checkout,
            }),
          },
          { conversationId: child.id, ownership: { kind: "conversation" }, background: true },
        );

        state.children[key] = {
          id: child.id,
          model,
          content: input.prompt,
          mode,
          createdAt: now,
        };

        return { ok: true, taskId: String(child.id), model, url: "", createdAt: now };
      }, context),
    );

    if (!created.ok) return created;
    const url = yield* Effect.promise(() => this.link(created.taskId));

    return { ...created, url } satisfies SpawnResult;
  });

  /**
   * Deliver a message from `caller` to a session it may reach. Reporting to its own parent gets
   * the server's evidence attached; every other delivery is labelled as a session's message. A
   * working target gets it in its current turn; an idle one starts a turn.
   */
  send = Effect.fn("Coordination.send")(function* (
    this: Coordination,
    caller: ConversationId,
    input: { id: string; message: string; deliveryId: string },
    context = BACKGROUND_CONTEXT,
  ) {
    if (!input.message.trim())
      return { ok: false as const, error: "Nothing to send (empty message)." };

    const reached = yield* attempt("session.reach", () => this.reach(caller, input.id, context));

    if (!reached.ok) return { ok: false as const, error: reached.error };
    const { target } = reached;

    const conversation = yield* attempt("target.open", () =>
      this.harness.conversation(target, context),
    );

    if (!conversation) return { ok: false as const, error: `No session with id \`${input.id}\`.` };

    // The facts are snapshotted at send time, so a redelivery repeats what the worker sent.
    const content = reached.parent
      ? workerReportMessage({
          child: String(caller),
          message: input.message,
          evidence: formatHandoffEvidence(yield* this.evidence(caller, "running", context)),
        })
      : sessionNoticeMessage({
          from: String(caller),
          relation: reached.child ? "Your parent session" : "Session",
          message: input.message,
        });

    const now = this.now();

    // A follow-up that starts an idle child's run takes one of the parent's working slots.
    const subtrees = yield* attempt("children.subtrees", () =>
      this.subtrees(reached.child ? caller : undefined, context),
    );

    const status = yield* attempt("target.deliver", () =>
      conversation.commit(async (tx) => {
        const busy = await workingIn(tx, subtrees.get(String(target)) ?? [target]);

        if (!busy && reached.child) {
          let working = 0;

          for (const ids of subtrees.values()) if (await workingIn(tx, ids)) working++;

          if (working >= MAX_WORKING) return "full" as const;
        }

        await conversation.submit(tx, {
          type: "input",
          content,
          requestId: `session-message:${input.deliveryId}`,
          whenBusy: "steer",
        });

        if (reached.parent) {
          const record = findChild(await tx.doc(Children, target), caller);

          if (record) record.lastReportAt = now;
        }

        return busy ? ("steered" as const) : ("started" as const);
      }, context),
    );

    if (status === "full") return { ok: false as const, error: WORKING_LIMIT };

    return {
      ok: true as const,
      deliveryId: input.deliveryId,
      status,
      message:
        status === "steered"
          ? "It is mid-run, so the message is folded into its current turn at the next stopping point."
          : "It was idle, so the message started a new turn.",
    };
  });

  /** The facts of a session's work, computed from its transcript. */
  evidence = Effect.fn("Coordination.evidence")(function* (
    this: Coordination,
    id: ConversationId,
    state: EvidenceState | undefined,
    context = BACKGROUND_CONTEXT,
  ) {
    const [entries, workspace] = yield* attempt("session.evidence", () =>
      Promise.all([
        readTranscript(this.harness, id, EVIDENCE_SCAN_ENTRIES, context),
        this.harness.snapshot(ConversationWorkspace, id, context),
      ]),
    );

    const facts = evidenceFromTranscript(entries);

    const working =
      state ??
      ((yield* attempt("session.working", () => this.subtreeWorking(id, context)))
        ? "running"
        : facts.lastRunError
          ? "error"
          : "done");

    const config = workspace?.config;

    const evidence: HandoffEvidence = {
      sessionId: String(id),
      state: working,
      files: facts.files,
      failures: facts.failures,
      commands: facts.commands,
      git: facts.git,
      turns: facts.turns,
      ...(facts.pr !== undefined && { pr: facts.pr }),
      ...(facts.lastRunError !== undefined && { lastRunError: facts.lastRunError }),
      ...(config && { branch: config.branch, repository: config.repository }),
      ...(workspace?.sharedWith !== undefined && { shared: true }),
    };

    return evidence;
  });

  list = Effect.fn("Coordination.list")(function* (this: Coordination, parent: ConversationId) {
    const state = yield* attempt("children.read", () =>
      this.harness.snapshot(Children, parent, BACKGROUND_CONTEXT),
    );

    const children = Object.values(state?.children ?? {});

    const working = yield* attempt("children.working", () =>
      Promise.all(children.map((child) => this.subtreeWorking(child.id, BACKGROUND_CONTEXT))),
    );

    return {
      children: children.map((child, index) => ({
        id: String(child.id),
        model: child.model,
        title: title(child.content),
        mode: child.mode ?? "code",
        state: working[index] ? ("running" as const) : ("idle" as const),
      })),
    };
  });

  /** One session's state, the server's evidence and its recent transcript, for task_status. */
  status = Effect.fn("Coordination.status")(function* (
    this: Coordination,
    caller: ConversationId,
    id: string,
    lines = 12,
    context = BACKGROUND_CONTEXT,
  ) {
    const reached = yield* attempt("session.reach", () => this.reach(caller, id, context));

    if (!reached.ok) return { ok: false as const, error: reached.error };
    const { target } = reached;

    const conversation = yield* attempt("session.open", () =>
      this.harness.conversation(target, context),
    );

    if (!conversation) return { ok: false as const, error: `No task/session with id \`${id}\`.` };

    const [entries, workspace, working, parent, agent, named] = yield* attempt("session.read", () =>
      Promise.all([
        readTranscript(this.harness, target, EVIDENCE_SCAN_ENTRIES, context),
        this.harness.snapshot(ConversationWorkspace, target, context),
        this.subtreeWorking(target, context),
        this.harness.commit((tx) => parentOf(tx, target), context),
        conversation.agent(context),
        reached.child ? Promise.resolve(title(reached.child.content)) : this.deps.title?.(target),
      ]),
    );

    const facts = evidenceFromTranscript(entries);
    const state = working ? "running" : facts.lastRunError ? "error" : "done";
    const evidence = yield* this.evidence(target, state, context);
    const model = reached.child?.model ?? agent.model?.modelId;
    const last = entries.at(-1)?.model?.at(-1)?.timestamp;

    const meta = [
      working ? "running" : "idle",
      ...(reached.child?.mode ? [reached.child.mode] : []),
      ...(model ? [model] : []),
      ...(workspace?.config ? [`branch ${workspace.config.branch}`] : []),
      ...(parent !== undefined ? [`child of ${parent}`] : []),
      ...(reached.child?.createdAt ? [`createdAt=${iso(reached.child.createdAt)}`] : []),
      ...(last ? [relTime(last, this.now())] : []),
    ];

    const parts = [
      `Task \`${target}\` — *${state}* (${working ? "running" : "idle"})`,
      `${working ? "🟢" : "⚪"} *${named || "(untitled)"}*  \`${target}\`\n   ${meta.join(" · ")}`,
    ];

    if (state === "error" && facts.lastRunError) parts.push(`*Error:* ${facts.lastRunError}`);

    // Same block the child's report carries, so a poll and a handoff tell the same story.
    parts.push(formatHandoffEvidence(evidence, { title: "*Evidence* (server-computed):" }));
    parts.push(`*Recent transcript:*\n${transcriptTail(entries, lines)}`);

    return { ok: true as const, text: parts.join("\n"), state, title: named ?? "" };
  });

  cancel = Effect.fn("Coordination.cancel")(function* (
    this: Coordination,
    caller: ConversationId,
    id: string,
    context = BACKGROUND_CONTEXT,
  ) {
    const reached = yield* attempt("session.reach", () => this.reach(caller, id, context));

    if (!reached.ok || !reached.child)
      return `\`${id}\` was not spawned by this session; cancel_task only cancels tasks this session started with spawn_task.`;

    const target = reached.target;

    // A child whose own turn ended while one of its children still runs is still cancellable,
    // and cancelling it stops every session under it.
    const ids = yield* attempt("target.subtree", () => subtreeOf(this.harness, target, context));

    const working = yield* attempt("target.working", () =>
      Promise.all(
        ids.map((session) => this.harness.commit((tx) => isWorking(tx, session), context)),
      ),
    );

    if (!working.some(Boolean))
      return `Nothing to cancel on \`${id}\` (idle, done, or an external run this server doesn't own).`;

    for (const [index, session] of ids.entries()) {
      if (!working[index]) continue;

      const conversation = yield* attempt("target.open", () =>
        this.harness.conversation(session, context),
      );

      if (conversation)
        yield* attempt("target.abort", () => conversation.abort(context, { background: true }));
    }

    return `Cancelled task \`${id}\`.`;
  });

  /**
   * Tell a worker's parent that its run died here. A worker reports with send_to_session; one
   * whose run died can't call anything, and its parent is usually idle, so without this it would
   * wait forever. Failures only: success is the worker's own report. Never throws.
   */
  notifyParentOfFailedRun = async (child: ConversationId, error: string) => {
    try {
      const parent = await this.harness.commit((tx) => parentOf(tx, child), BACKGROUND_CONTEXT);

      if (parent === undefined) return "no-parent";
      const now = this.now();

      const record = findChild(
        await this.harness.snapshot(Children, parent, BACKGROUND_CONTEXT),
        child,
      );

      if (!record) return "no-parent";

      if (record.lastReportAt !== undefined && now - record.lastReportAt < REPORT_GRACE_MS)
        return "already-reported";

      if (record.notifiedAt !== undefined && now - record.notifiedAt < BEACON_THROTTLE_MS)
        return "throttled";

      const evidence = await Effect.runPromise(this.evidence(child, "error"));
      const conversation = await this.harness.conversation(parent, BACKGROUND_CONTEXT);

      if (!conversation) return "no-parent";

      await conversation.commit(async (tx) => {
        await conversation.submit(tx, {
          type: "input",
          content: workerFailureMessage({
            child: String(child),
            error,
            evidence: formatHandoffEvidence(evidence),
          }),
          requestId: `worker-failure:${child}:${Math.floor(now / BEACON_THROTTLE_MS)}`,
          whenBusy: "steer",
        });

        const current = findChild(await tx.doc(Children, parent), child);

        if (current) current.notifiedAt = now;
      }, BACKGROUND_CONTEXT);

      return "sent";
    } catch {
      return "failed";
    }
  };

  tools(): ToolRegistration[] {
    const text = (value: string): ToolExecutionResult => ({
      output: [{ type: "text", text: value }],
    });

    const run = <A>(effect: Effect.Effect<A, unknown>, context: Context) =>
      Effect.runPromise(effect, { signal: context.abortSignal });

    return [
      defineTool({
        name: "spawn_task",
        description: `Delegate a self-contained task to a child session and return IMMEDIATELY with {taskId, url}. The child is linked as a child of this session and is told to report back here with send_to_session; to wait for it, register wait_for kind=session_turn with its id and end your turn; poll it with task_status and stop it with cancel_task. Mode defaults to 'code': the child shares this session's checkout (same sandbox and branch, so it sees your uncommitted work) unless you pass isolatedWorktree true or a branch, which give it its own checkout and branch cloned fresh from your base ref, or a repo other than yours; use 'ask' for read-only investigation and 'scratch' for no repository. Loop guard: spawned children may delegate one further level, then spawn_task refuses (depth ≥ ${MAX_SPAWN_DEPTH}). Limits: ${MAX_WORKING} children working at once, ${MAX_CHILDREN} per session. Inherits your model unless model is supplied.`,
        parameters: obj({
          prompt: str({
            minLength: 1,
            maxLength: 32_768,
            description:
              "Self-contained task prompt: scope, relevant files, constraints, acceptance criteria, and what to report.",
          }),
          repo: opt(
            str({
              maxLength: 201,
              description: "owner/name. Defaults to this session's repository.",
            }),
          ),
          branch: opt(
            str({
              maxLength: 200,
              description:
                "Branch for code mode when the child gets its own checkout. Implies its own checkout.",
            }),
          ),
          isolatedWorktree: opt(
            bool({
              description:
                "Code mode: give the child its own checkout and branch instead of sharing this session's, keeping the child/report-back link. The branch is dolly/session-<child id> unless branch is given.",
            }),
          ),
          model: opt(str({ description: "Optional model id. Defaults to this session's model." })),
          mode: opt(
            oneOf(["ask", "code", "scratch"], {
              description:
                "'code' (default) can edit files and open PRs; 'ask' is read-only; 'scratch' has no repository.",
            }),
          ),
        }),
        replay: "safe",
        executionMode: "sequential",
        execute: async (input, api, context) => {
          const result = await run(
            this.spawn(api.conversationId, { ...input, requestId: `tool:${api.taskId}` }, context),
            context,
          );

          if (!result.ok) return text(result.error);

          return text(
            `Spawned task \`${result.taskId}\` — ${result.url}\nMetadata: model=${result.model} · createdAt=${iso(result.createdAt)}. It runs in the background. To wait for it, register wait_for kind=session_turn with session_id=${result.taskId} and end your turn; read its state with task_status(taskId) and stop it with cancel_task.`,
          );
        },
      }),
      defineTool({
        name: "task_status",
        description:
          "Status of a spawned task (or another session you can reach): running / done / error, the server-computed evidence (files written, commands run, failures the tools reported, git, PR) and the recent transcript tail.",
        parameters: obj({
          taskId: str({ description: "The task/session id returned by spawn_task." }),
          transcript_lines: opt(
            int({
              minimum: 1,
              maximum: 50,
              description: "Trailing transcript entries to include (default 12).",
            }),
          ),
        }),
        replay: "safe",
        execute: async ({ taskId, transcript_lines }, api, context) => {
          const status = await run(
            this.status(api.conversationId, taskId, transcript_lines ?? 12, context),
            context,
          );

          return text(status.ok ? status.text : status.error);
        },
      }),
      defineTool({
        name: "cancel_task",
        description:
          "Cancel a spawned task's in-flight run (drops queued messages too, and stops its own children). Only tasks this session started with spawn_task. The child can be resumed later with send_to_session.",
        parameters: obj({
          taskId: str({ description: "The task/session id returned by spawn_task." }),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: async ({ taskId }, api, context) =>
          text(await run(this.cancel(api.conversationId, taskId, context), context)),
      }),
      defineTool({
        name: "send_to_session",
        description:
          "Send a message to another session: a task you spawned, your parent (a worker reporting back), or, in sessions started from the web app, any other session. If it's mid-run it's folded into the current turn (picked up at the next stopping point); if it's idle it starts a new turn. Use this to redirect or follow up on a child without opening it. To wait for the reply, register wait_for kind=session_turn with that session's id and end your turn; do not schedule a timer and guess. A report to your own parent gets a server-computed evidence block appended.",
        parameters: obj({
          id: str({ description: "The target session's id." }),
          message: str({
            minLength: 1,
            maxLength: 32_768,
            description: "The message to deliver.",
          }),
          delivery_id: opt(
            str({
              maxLength: 128,
              description:
                "Optional caller-generated correlation id. Omit to receive a generated delivery receipt.",
            }),
          ),
        }),
        replay: "safe",
        executionMode: "sequential",
        execute: async ({ id, message, delivery_id }, api, context) => {
          const result = await run(
            this.send(
              api.conversationId,
              { id, message, deliveryId: delivery_id?.trim() || `tool:${api.taskId}` },
              context,
            ),
            context,
          );

          return text(
            result.ok
              ? `Delivery \`${result.deliveryId}\` status=${result.status}: ${result.message}`
              : result.error,
          );
        },
      }),
      defineTool({
        name: "list_children",
        description:
          "List the tasks this session spawned: id, model, mode, task title, and whether each is running or idle.",
        parameters: obj({}),
        replay: "safe",
        execute: async (_, api, context) =>
          text(JSON.stringify(await run(this.list(api.conversationId), context))),
      }),
    ];
  }
}

/** A child's workspace document, and how its briefing describes it. */
type ChildPlacement = { workspace?: WorkspaceState; checkout: ChildCheckout };

/**
 * Where a child works. Code mode shares the parent's checkout (its sandboxes) when the repository
 * matches and nothing asks for isolation; otherwise the child gets its own checkout and branch.
 * Ask mode is a read-only checkout of its own: a sandbox is configured once, so a read-only child
 * can't share a writable parent's.
 */
function childWorkspace(input: {
  parent: WorkspaceState | undefined;
  parentId: string;
  childId: string;
  mode: ChildMode;
  repository: string | undefined;
  sameRepository: boolean;
  branch?: string;
  isolated: boolean;
}): ChildPlacement {
  const parentConfig = input.parent?.config;

  // A read-only parent (such as a pull request reviewer) can't grant write access through a
  // child: whatever the mode or repository, the child gets a read-only checkout, never none.
  const inherited = parentConfig?.readOnly === true;
  const repository = input.repository ?? (inherited ? parentConfig.repository : undefined);

  if ((input.mode === "scratch" && !inherited) || !repository)
    return { checkout: { kind: "none" } };

  const ref = input.sameRepository && parentConfig ? parentConfig.ref : "HEAD";

  if (input.mode === "ask" || inherited) {
    const config = workspaceConfig({ repository, ref }, input.childId, {
      readOnly: true,
    });

    return {
      workspace: { config },
      checkout: { kind: "read-only", repository: config.repository, ref },
    };
  }

  if (
    input.sameRepository &&
    parentConfig &&
    !parentConfig.readOnly &&
    !input.isolated &&
    input.branch === undefined
  )
    return {
      workspace: {
        config: parentConfig,
        sharedWith: input.parent?.sharedWith ?? input.parentId,
        ...(input.parent?.attached && { attached: input.parent.attached }),
        ...(input.parent?.activeRepository && {
          activeRepository: input.parent.activeRepository,
        }),
      },
      checkout: {
        kind: "shared",
        repository: parentConfig.repository,
        branch: parentConfig.branch,
      },
    };

  const config = {
    ...workspaceConfig({ repository, ref }, input.childId),
    ...(input.sameRepository && parentConfig && { networkHosts: parentConfig.networkHosts }),
    ...(input.branch !== undefined && { branch: input.branch }),
  };

  return {
    workspace: { config },
    checkout: { kind: "isolated", repository: config.repository, branch: config.branch, ref },
  };
}
