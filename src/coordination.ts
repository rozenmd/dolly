import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  configure,
  type ConversationHandle,
  defineDoc,
  defineTool,
  type ToolExecutionResult,
  defineTask,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type TaskId,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ConversationWorkspace } from "./workspace";
import { SessionModel, modelProvider, ChildRequest, ChildMessage } from "./models";
import { attempt } from "./operations";
import { childReportMessage } from "./child-report-message";
import {
  childEvidence,
  formatChildEvidence,
  lastReply,
  tail,
  workerBriefing,
} from "./child-report";

/**
 * Child sessions. A session delegates self-contained work with spawn_task and ends its turn; it is
 * never held open waiting. Each message to a child (its task, a follow-up, or a report from one of
 * its own children) is delivered by a background task that waits for the child's turn to end and
 * then reports back: the child's final reply, with facts computed from its transcript attached, as
 * a new message in the parent. A child that is itself waiting on children reports once they are
 * done, so a parent hears from each subtree once its work settles.
 */

export const MAX_DEPTH = 3;

/** Children working at once: those with a message they haven't finished a turn on. */
export const MAX_WORKING = 8;

/** Children one session may start over its lifetime. */
export const MAX_CHILDREN = 32;

/** Messages queued for one child that it hasn't answered yet. */
export const MAX_PENDING = 8;

/** Settled message receipts kept for request deduplication. */
const KEPT_RECEIPTS = 64;

/** How much of a child's final reply a report carries. */
const REPLY_MAX_CHARS = 8_000;

/** How much of a child's transcript one report reads for evidence. */
const EVIDENCE_SCAN_ENTRIES = 2_000;

/** Pi's ownership edges are authoritative for ancestry and recursive cancellation. */
export const SessionIndex = defineDoc<{ ids: Record<string, ConversationId> }>({
  kind: "app.session-index",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {} }),
  checkpointWhen: () => false,
});

type DeliveryInput = {
  childId: ConversationId;
  content: string;
  /** The session the child reports back to; absent on deliveries made before reports existed. */
  parentId?: ConversationId;
};

type DeliveryResult =
  | { status: "answered"; text: string }
  | { status: "unanswered"; reason: string };

type Child = {
  id: ConversationId;
  model: string;
  /** The task as the parent wrote it, without the worker briefing. */
  content: string;
  taskId: TaskId<DeliveryResult>;
  /** The answer entry last reported, so two messages answered together report once. */
  reported?: string;
  /** The newest entry a report has covered: the next report's evidence starts after it. */
  reportedThrough?: EntryId;
  /** Its report waits for its own children to answer; it counts as working meanwhile. */
  held?: true;
  /** How the child's last turn ended, for status reads. */
  last?: { outcome: "answered" | "stopped"; reason?: string; at: number };
};

type Delivery = {
  id: TaskId<DeliveryResult>;
  childId: ConversationId;
  content: string;
  /** Not yet answered: the child is working on it. */
  pending?: true;
};

const Children = defineDoc<{
  children: Record<string, Child>;
  deliveries: Record<string, Delivery>;
}>({
  kind: "app.children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ children: {}, deliveries: {} }),
  checkpointWhen: () => false,
});

type ChildrenState = { children: Record<string, Child>; deliveries: Record<string, Delivery> };

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

const findChild = (state: ChildrenState, id: ConversationId | string) =>
  Object.values(state.children).find((child) => String(child.id) === String(id));

/** Children with a message they haven't finished a turn on. */
const pending = (state: ChildrenState) =>
  new Set(
    Object.values(state.deliveries)
      .filter((delivery) => delivery.pending)
      .map((delivery) => String(delivery.childId)),
  );

/**
 * Children still working: those with unanswered messages, and those whose report is held until
 * their own children answer, so a whole subtree counts as working until its deepest child settles.
 */
const working = (state: ChildrenState) => {
  const ids = pending(state);

  for (const child of Object.values(state.children)) if (child.held) ids.add(String(child.id));

  return ids;
};

const title = (content: string) => content.trim().split("\n")[0]?.slice(0, 80) ?? "";

/** Marks a delivery answered and forgets old receipts beyond what deduplication needs. */
function settle(state: ChildrenState, id: TaskId<DeliveryResult>) {
  for (const [key, delivery] of Object.entries(state.deliveries))
    if (String(delivery.id) === String(id)) {
      // Reports between sessions have no request to deduplicate against.
      if (key.startsWith("report:")) delete state.deliveries[key];
      else delete delivery.pending;
    }

  const settled = Object.entries(state.deliveries).filter(
    ([key, delivery]) => !delivery.pending && !key.startsWith("spawn:"),
  );

  for (const [key] of settled.slice(0, Math.max(0, settled.length - KEPT_RECEIPTS)))
    delete state.deliveries[key];
}

/** A span of a conversation's transcript, oldest first, bounded. */
async function readSpan(
  read: (
    query: { minEntryId?: EntryId; maxEntryId?: EntryId; order: "ascending" },
    limit: number,
    cursor: Cursor | undefined,
  ) => Promise<{ items: readonly EntryRecord[]; next?: Cursor }>,
  after: EntryId | undefined,
  through: EntryId | undefined,
) {
  const items: EntryRecord[] = [];
  let cursor: Cursor | undefined;

  const query = {
    order: "ascending" as const,
    ...(after !== undefined && { minEntryId: after }),
    ...(through !== undefined && { maxEntryId: through }),
  };

  do {
    const page = await read(query, 200, cursor);

    // The range is inclusive; the entry the last report covered is not news.
    items.push(...page.items.filter((entry) => entry.id !== after));
    cursor = page.next;
  } while (cursor && items.length < EVIDENCE_SCAN_ENTRIES);

  return items.slice(-EVIDENCE_SCAN_ENTRIES);
}

const DeliveryTask = defineTask<DeliveryInput, { phase: "deliver" }, DeliveryResult>({
  name: "app.child-delivery",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: (task, runtime, context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { childId, parentId } = task.input;

          const child = yield* attempt("child.open", () => runtime.conversation(childId, context));

          if (!child) return yield* Effect.die("Child conversation missing");

          // A working child takes the message into its current turn; an idle one starts a turn.
          const submission = yield* attempt("child.submit", () =>
            child.submit(
              {
                type: "input",
                content: task.input.content,
                requestId: `delivery:${task.id}`,
                whenBusy: "steer",
              },
              context,
            ),
          );

          const settled = yield* attempt("child.wait", () => submission.wait(context));

          const answer =
            settled.type === "input" && settled.status === "done" ? settled.answer : undefined;

          // The span since the last report, read before the commit: committed entries don't change.
          const before = parentId
            ? yield* attempt("children.read", () => runtime.snapshot(Children, parentId, context))
            : undefined;

          const span = parentId
            ? yield* attempt("child.entries", () =>
                readSpan(
                  (query, limit, cursor) => runtime.entries(query, limit, cursor, context),
                  before ? findChild(before, childId)?.reportedThrough : undefined,
                  answer,
                ),
              )
            : [];

          const parent = parentId
            ? yield* attempt("parent.open", () => runtime.conversation(parentId, context))
            : undefined;

          yield* attempt("child.settle", () =>
            runtime.commit(async (tx) => {
              const answered =
                answer === undefined ? undefined : await tx.entry(AssistantEntry, answer);

              const result: DeliveryResult =
                settled.status === "unanswered"
                  ? { status: "unanswered", reason: settled.reason }
                  : answer === undefined
                    ? { status: "unanswered", reason: "Unexpected submission type" }
                    : {
                        status: "answered",
                        text: lastReply(answered ? [answered] : []).slice(0, 16_384),
                      };

              if (parentId)
                await report(tx, {
                  task: task.id,
                  parentId,
                  childId,
                  parent,
                  result,
                  answer,
                  span,
                  now: runtime.now(),
                });

              return { status: "terminal", outcome: { status: "completed", result } };
            }, context),
          );
        }),
        { signal: context.abortSignal },
      ),
  },
  abort: (task, runtime, context) =>
    runtime.commit(async (tx) => {
      // A stopped message no longer counts as work, so the parent's own report isn't held up.
      if (task.input.parentId) {
        const state = await tx.doc(Children, task.input.parentId);
        settle(state, task.id);
        const child = findChild(state, task.input.childId);

        if (child) {
          child.last = { outcome: "stopped", reason: "aborted", at: runtime.now() };
          delete child.held;
        }

        await release(tx, task.input.parentId);
      }

      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
});

/**
 * Releases holds a stopped subtree left behind: a child held for its own children's reports gets
 * none once their work is stopped, so when `id` has nothing left working, it no longer counts as
 * working in its parent, and so on up the chain.
 */
async function release(tx: Tx, id: ConversationId) {
  let current = id;

  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (working(await tx.doc(Children, current)).size > 0) return;
    const owner = (await tx.conversation(current))?.owner?.conversationId;

    if (owner === undefined) return;
    const child = findChild(await tx.doc(Children, owner), current);

    if (!child?.held) return;
    delete child.held;
    current = owner;
  }
}

/**
 * Settle one delivery and, when the child's work has settled (none of its own children are still
 * working), send its report to the parent: straight into a top-level parent, or through another
 * delivery into a parent that is itself a child, so that parent's answer reports upward in turn.
 */
async function report(
  tx: Tx,
  input: {
    task: TaskId<DeliveryResult>;
    parentId: ConversationId;
    childId: ConversationId;
    parent: ConversationHandle | undefined;
    result: DeliveryResult;
    answer: EntryId | undefined;
    span: readonly EntryRecord[];
    now: number;
  },
) {
  const state = await tx.doc(Children, input.parentId);
  settle(state, input.task);
  const child = findChild(state, input.childId);

  if (!child) return;

  // Stopping is the owner's or the parent's own doing; it isn't news to report.
  if (input.result.status === "unanswered" && input.result.reason === "aborted") {
    child.last = { outcome: "stopped", reason: "aborted", at: input.now };
    delete child.held;

    return;
  }

  child.last =
    input.result.status === "answered"
      ? { outcome: "answered", at: input.now }
      : { outcome: "stopped", reason: input.result.reason, at: input.now };

  const key = input.answer === undefined ? `task:${input.task}` : String(input.answer);

  if (child.reported === key) return;

  // The child still has messages to answer (a follow-up, or a report from its own child), or is
  // waiting on children of its own: it reports once all of that has settled, covering it all.
  if (pending(state).has(String(input.childId))) return;

  if (working(await tx.doc(Children, input.childId)).size > 0) {
    child.held = true;

    return;
  }

  delete child.held;
  child.reported = key;
  const newest = input.span.at(-1)?.id;

  if (newest !== undefined) child.reportedThrough = newest;
  const workspace = (await tx.doc(ConversationWorkspace, input.childId)).config;
  const reply = lastReply(input.span);

  const others = [...working(state)].flatMap((id) => {
    if (id === String(input.childId)) return [];
    const other = findChild(state, id);

    return [other ? `${id} (${title(other.content)})` : id];
  });

  const content = childReportMessage({
    child: String(input.childId),
    outcome: input.result.status === "answered" ? "answered" : "stopped",
    headline:
      input.result.status === "answered"
        ? (reply
            .split("\n")
            .find((line) => line.trim())
            ?.trim()
            .slice(0, 100) ?? "finished")
        : `stopped: ${input.result.reason}`,
    task: title(child.content),
    reply:
      input.result.status === "answered"
        ? tail(reply, REPLY_MAX_CHARS)
        : `The child's turn ended without an answer (${input.result.reason}).${reply ? `\n\nIts last message:\n${tail(reply, REPLY_MAX_CHARS)}` : ""}`,
    evidence: formatChildEvidence(childEvidence(input.span), {
      repository: workspace?.repository,
      branch: workspace?.branch,
    }),
    working: others.length
      ? `${others.length} other child session${others.length === 1 ? "" : "s"}: ${others.join(", ")}`
      : "",
  });

  const grandparent = (await tx.conversation(input.parentId))?.owner?.conversationId;

  if (grandparent === undefined) {
    await input.parent?.submit(tx, {
      type: "input",
      content,
      requestId: `child-report:${input.task}`,
      whenBusy: "followUp",
    });

    return;
  }

  // The parent is a child too: deliver the report like any message, so its answer reports upward.
  const taskId = await tx.createTask(
    DeliveryTask,
    { childId: input.parentId, content, parentId: grandparent },
    { conversationId: input.parentId, ownership: { kind: "conversation" }, background: true },
  );

  (await tx.doc(Children, grandparent)).deliveries[`report:${taskId}`] = {
    id: taskId,
    childId: input.parentId,
    content: "",
    pending: true,
  };
}

export const coordinationTasks = [Anchor, DeliveryTask];

export async function indexSession(tx: Tx, id: ConversationId) {
  (await tx.doc(SessionIndex)).ids[id] = id;
}

export type ChildState = "working" | "idle" | "stopped";

function childState(state: ChildrenState, child: Child): ChildState {
  if (working(state).has(String(child.id))) return "working";

  return child.last?.outcome === "stopped" ? "stopped" : "idle";
}

export class Coordination {
  constructor(private readonly getHarness: () => Harness) {}

  private get harness() {
    return this.getHarness();
  }

  resolve = Effect.fn("Coordination.resolve")((id: string) =>
    attempt("session.index", () => this.harness.snapshot(SessionIndex, BACKGROUND_CONTEXT)).pipe(
      Effect.map((index) => (Object.hasOwn(index?.ids ?? {}, id) ? index?.ids[id] : undefined)),
    ),
  );

  spawn = Effect.fn("Coordination.spawn")(function* (
    this: Coordination,
    parent: ConversationId,
    input: typeof ChildRequest.Type,
    context = BACKGROUND_CONTEXT,
  ) {
    const conversation = yield* attempt("parent.open", () =>
      this.harness.conversation(parent, context),
    );

    if (!conversation) return { error: "Session not found" };
    const agent = yield* attempt("parent.model", () => conversation.agent(context));

    const model = yield* Schema.decodeUnknownEffect(SessionModel)(
      input.model ?? agent.model?.modelId,
    ).pipe(Effect.orDie);

    return yield* attempt("child.create", () =>
      conversation.commit(async (tx) => {
        const state = await tx.doc(Children, parent);
        const key = input.requestId;

        if (Object.hasOwn(state.children, key)) {
          const existing = state.children[key];

          return existing.content === input.content && existing.model === model
            ? { id: String(existing.id), model: existing.model }
            : { error: "requestId already used with different content or model" };
        }

        if (Object.keys(state.children).length >= MAX_CHILDREN)
          return { error: `Child limit reached (${MAX_CHILDREN} per session)` };

        if (working(state).size >= MAX_WORKING)
          return {
            error: `${MAX_WORKING} child sessions are already working. Wait for a report, or stop one with cancel_task.`,
          };
        let depth = 0;
        let ancestor = await tx.conversation(parent);

        while (ancestor?.owner) {
          depth++;
          ancestor = await tx.conversation(ancestor.owner.conversationId);
        }

        if (depth >= MAX_DEPTH)
          return {
            error: `Nesting limit reached (${MAX_DEPTH} child levels). Do the work here instead of delegating further.`,
          };

        const anchor = await tx.createTask(Anchor, null, {
          ownership: { kind: "conversation" },
          background: true,
        });

        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, {
          model: { provider: modelProvider(model), modelId: model },
        });
        const parentWorkspace = await tx.doc(ConversationWorkspace, parent);

        const config = parentWorkspace.config && {
          ...parentWorkspace.config,
          branch: `dolly/session-${child.id}`,
        };

        if (config) (await tx.doc(ConversationWorkspace, child.id)).config = config;

        const briefing = workerBriefing({
          repository: config?.repository,
          branch: config?.branch,
        });

        const content = `${input.content}\n\n${briefing}`;

        const taskId = await tx.createTask(
          DeliveryTask,
          { childId: child.id, content, parentId: parent },
          {
            conversationId: child.id,
            ownership: { kind: "conversation" },
            background: true,
          },
        );

        state.children[key] = { id: child.id, model, content: input.content, taskId };
        state.deliveries[`spawn:${key}`] = {
          id: taskId,
          childId: child.id,
          content: input.content,
          pending: true,
        };

        return { id: String(child.id), model };
      }, context),
    );
  });

  send = Effect.fn("Coordination.send")(function* (
    this: Coordination,
    parent: ConversationId,
    childId: string,
    input: typeof ChildMessage.Type,
    context = BACKGROUND_CONTEXT,
  ) {
    return yield* attempt("child.message", () =>
      this.harness.commit(async (tx) => {
        const state = await tx.doc(Children, parent);
        const child = findChild(state, childId);

        if (!child) return { error: "Not a direct child of this session" };
        const key = `send:${input.requestId}`;

        if (Object.hasOwn(state.deliveries, key)) {
          const existing = state.deliveries[key];

          return existing.childId === child.id && existing.content === input.content
            ? { id: String(child.id), sent: true }
            : { error: "requestId already used with different target or content" };
        }

        const pending = Object.values(state.deliveries).filter(
          (delivery) => delivery.pending && delivery.childId === child.id,
        ).length;

        const busy = working(state);

        // An idle child given new work becomes a working one, under the same limit as spawning.
        if (!busy.has(String(child.id)) && busy.size >= MAX_WORKING)
          return {
            error: `${MAX_WORKING} child sessions are already working. Wait for a report, or stop one with cancel_task.`,
          };

        if (pending >= MAX_PENDING)
          return {
            error: `${MAX_PENDING} messages to this child are still unanswered. Wait for its report.`,
          };

        const taskId = await tx.createTask(
          DeliveryTask,
          { childId: child.id, content: input.content, parentId: parent },
          {
            conversationId: child.id,
            ownership: { kind: "conversation" },
            background: true,
          },
        );

        state.deliveries[key] = {
          id: taskId,
          childId: child.id,
          content: input.content,
          pending: true,
        };

        return { id: String(child.id), sent: true };
      }, context),
    );
  });

  list = Effect.fn("Coordination.list")(function* (this: Coordination, parent: ConversationId) {
    const state = yield* attempt("children.read", () =>
      this.harness.snapshot(Children, parent, BACKGROUND_CONTEXT),
    );

    const current = state ?? { children: {}, deliveries: {} };

    return {
      children: Object.values(current.children).map((child) => ({
        id: String(child.id),
        model: child.model,
        title: title(child.content),
        state: childState(current, child),
      })),
    };
  });

  /** A direct child as it stands: working or not, its latest reply and what it did since its last report. */
  status = Effect.fn("Coordination.status")(function* (
    this: Coordination,
    parent: ConversationId,
    childId: string,
    context = BACKGROUND_CONTEXT,
  ) {
    const state = yield* attempt("children.read", () =>
      this.harness.snapshot(Children, parent, context),
    );

    const current = state ?? { children: {}, deliveries: {} };
    const child = findChild(current, childId);

    if (!child) return { error: "Not a direct child of this session" };

    const conversation = yield* attempt("child.open", () =>
      this.harness.conversation(child.id, context),
    );

    if (!conversation) return { error: "Child session not found" };

    const span = yield* attempt("child.entries", () =>
      readSpan(
        (query, limit, cursor) => conversation.entries(query, limit, cursor, context),
        child.reportedThrough,
        undefined,
      ),
    );

    // The latest reply may predate the last report, so it comes from the transcript's end.
    const recent = yield* attempt("child.recent", () =>
      conversation.entries({ order: "descending" }, 50, undefined, context),
    );

    const workspace = yield* attempt("child.workspace", () =>
      this.harness.snapshot(ConversationWorkspace, child.id, context),
    );

    const pending = Object.values(current.deliveries).filter(
      (delivery) => delivery.pending && delivery.childId === child.id,
    ).length;

    return {
      id: String(child.id),
      model: child.model,
      title: title(child.content),
      state: childState(current, child),
      ...(pending && { unanswered_messages: pending }),
      ...(child.last && {
        last_turn: child.last.reason
          ? `${child.last.outcome} (${child.last.reason})`
          : child.last.outcome,
      }),
      latest_reply: tail(lastReply([...recent.items].reverse()), 4_000) || undefined,
      since_last_report: formatChildEvidence(childEvidence(span), {
        repository: workspace?.config?.repository,
        branch: workspace?.config?.branch,
      }),
    };
  });

  cancel = Effect.fn("Coordination.cancel")(function* (
    this: Coordination,
    parent: ConversationId,
    childId: string,
    context = BACKGROUND_CONTEXT,
  ) {
    const state = yield* attempt("children.read", () =>
      this.harness.snapshot(Children, parent, context),
    );

    const child = state ? findChild(state, childId) : undefined;

    if (!child) return { error: "Not a direct child of this session" };

    const conversation = yield* attempt("child.open", () =>
      this.harness.conversation(child.id, context),
    );

    if (conversation)
      yield* attempt("child.abort", () => conversation.abort(context, { background: true }));

    // A held child has no live task of its own to abort, so its slot is released here.
    yield* attempt("child.stopped", () =>
      this.harness.commit(async (tx) => {
        const current = findChild(await tx.doc(Children, parent), childId);

        if (!current) return;
        delete current.held;
        current.last = { outcome: "stopped", reason: "aborted", at: Date.now() };
      }, context),
    );

    return { id: String(child.id), state: "stopped" };
  });

  tools(): ToolRegistration[] {
    const reply = <A>(effect: Effect.Effect<A, unknown>, context: Context) =>
      Effect.runPromise(
        effect.pipe(
          Effect.map((result): ToolExecutionResult => ({
            output: [{ type: "text", text: JSON.stringify(result) }],
          })),
        ),
        { signal: context.abortSignal },
      );

    const noted = <A extends object>(result: A, note: string) =>
      "error" in result ? result : { ...result, note };

    return [
      defineTool({
        name: "spawn_task",
        description: `Start a child session for a self-contained task, in its own sandbox, and return at once with its id. Write the task so it stands alone: goal, context, constraints, acceptance criteria and what to report. The child reports back here as a new message when its turn ends (once its own children have answered): its final reply, plus facts Dolly computed from its transcript (files written, commands run, failures, commits, pushes and pull requests). So end your turn after spawning instead of polling or sleeping. Inherits your model unless model is supplied. Limits: ${MAX_DEPTH} child levels, ${MAX_WORKING} children working at once, ${MAX_CHILDREN} per session.`,
        parameters: obj({ content: str({ minLength: 1, maxLength: 32_768 }), model: opt(str()) }),
        replay: "safe",
        executionMode: "sequential",
        execute: (input, api, context) =>
          reply(
            Schema.decodeUnknownEffect(ChildRequest)({
              ...input,
              requestId: `tool:${api.taskId}`,
            }).pipe(
              Effect.flatMap((parsed) => this.spawn(api.conversationId, parsed, context)),
              Effect.map((result) =>
                noted(
                  result,
                  "The child is working in the background and reports back here when its turn ends. End your turn now unless you have other work to do; don't poll. Follow up with send_to_session, look in with task_status, stop it with cancel_task.",
                ),
              ),
            ),
            context,
          ),
      }),
      defineTool({
        name: "send_to_session",
        description:
          "Send a follow-up to one of your direct children (id from spawn_task or list_children). A working child gets it in its current turn; an idle one starts a new turn. Its answer reports back here like the first one, so end your turn instead of polling.",
        parameters: obj({ id: str(), content: str({ minLength: 1, maxLength: 32_768 }) }),
        replay: "safe",
        executionMode: "sequential",
        execute: ({ id, content }, api, context) =>
          reply(
            this.send(
              api.conversationId,
              id,
              { content, requestId: `tool:${api.taskId}` },
              context,
            ).pipe(
              Effect.map((result) =>
                noted(result, "Sent. The child reports back here when its turn ends."),
              ),
            ),
            context,
          ),
      }),
      defineTool({
        name: "list_children",
        description:
          "List your direct children: id, model, task title, and whether each is working, idle or stopped.",
        parameters: obj({}),
        replay: "safe",
        execute: (_, api, context) => reply(this.list(api.conversationId), context),
      }),
      defineTool({
        name: "task_status",
        description:
          "Look in on a direct child without waiting: whether it is working, its latest reply, and what it has done since its last report (files written, commands run, failures, commits, pushes and pull requests).",
        parameters: obj({ id: str() }),
        replay: "safe",
        execute: ({ id }, api, context) =>
          reply(this.status(api.conversationId, id, context), context),
      }),
      defineTool({
        name: "cancel_task",
        description:
          "Stop a direct child, its unanswered messages and all its descendants. Stopped work sends no report. The child can receive new messages afterwards.",
        parameters: obj({ id: str() }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: ({ id }, api, context) =>
          reply(this.cancel(api.conversationId, id, context), context),
      }),
    ];
  }
}
