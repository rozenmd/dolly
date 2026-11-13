import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineTool,
  type ToolExecutionResult,
  defineTask,
  type ConversationId,
  type Harness,
  type TaskId,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ConversationWorkspace } from "./workspace";
import { CodexModel, ChildRequest, ChildMessage } from "./models";
import { attempt } from "./operations";

export const MAX_DEPTH = 3;
export const MAX_CHILDREN = 8;
export const MAX_DELIVERIES = 32;

/** Pi's ownership edges are authoritative for ancestry and recursive cancellation. */
export const SessionIndex = defineDoc<{ ids: Record<string, ConversationId> }>({
  kind: "app.session-index",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {} }),
  checkpointWhen: () => false,
});

type DeliveryInput = { childId: ConversationId; content: string };

type DeliveryResult =
  | { status: "answered"; text: string }
  | { status: "unanswered"; reason: string };

type Child = { id: ConversationId; model: string; content: string; taskId: TaskId<DeliveryResult> };

const Children = defineDoc<{
  children: Record<string, Child>;
  deliveries: Record<
    string,
    { id: TaskId<DeliveryResult>; childId: ConversationId; content: string }
  >;
}>({
  kind: "app.children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ children: {}, deliveries: {} }),
  checkpointWhen: () => false,
});

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

const Delivery = defineTask<DeliveryInput, { phase: "deliver" }, DeliveryResult>({
  name: "app.child-delivery",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: (task, runtime, context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const child = yield* attempt("child.open", () =>
            runtime.conversation(task.input.childId, context),
          );

          if (!child) return yield* Effect.die("Child conversation missing");

          const submission = yield* attempt("child.submit", () =>
            child.submit(
              {
                type: "input",
                content: task.input.content,
                requestId: `delivery:${task.id}`,
                whenBusy: "followUp",
              },
              context,
            ),
          );

          const settled = yield* attempt("child.wait", () => submission.wait(context));
          yield* attempt("child.settle", () =>
            runtime.commit(async (tx) => {
              let result: DeliveryResult;

              if (settled.status === "unanswered")
                result = { status: "unanswered", reason: settled.reason };
              else if (settled.type === "input") {
                const entry = await tx.entry(AssistantEntry, settled.answer);

                const text = (entry?.model ?? [])
                  .flatMap((message) =>
                    message.role === "assistant"
                      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
                      : [],
                  )
                  .join("\n");

                result = { status: "answered", text: text.slice(0, 16_384) };
              } else result = { status: "unanswered", reason: "Unexpected submission type" };

              return { status: "terminal", outcome: { status: "completed", result } };
            }, context),
          );
        }),
        { signal: context.abortSignal },
      ),
  },
  abort: (_, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export const coordinationTasks = [Anchor, Delivery];

export async function indexSession(tx: Tx, id: ConversationId) {
  (await tx.doc(SessionIndex)).ids[id] = id;
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

    const model = yield* Schema.decodeUnknownEffect(CodexModel)(
      input.model ?? agent.model?.modelId,
    ).pipe(Effect.orDie);

    return yield* attempt("child.create", () =>
      conversation.commit(async (tx) => {
        const state = await tx.doc(Children, parent);
        const key = input.requestId;

        if (Object.hasOwn(state.children, key)) {
          const existing = state.children[key];

          return existing.content === input.content && existing.model === model
            ? { id: String(existing.id), model: existing.model, taskId: String(existing.taskId) }
            : { error: "requestId already used with different content or model" };
        }

        if (Object.keys(state.children).length >= MAX_CHILDREN)
          return { error: "Child limit reached (8 per session)" };

        if (Object.keys(state.deliveries).length >= MAX_DELIVERIES)
          return { error: "Delivery limit reached (32 per session)" };
        let depth = 0;
        let ancestor = await tx.conversation(parent);

        while (ancestor?.owner) {
          depth++;
          ancestor = await tx.conversation(ancestor.owner.conversationId);
        }

        if (depth >= MAX_DEPTH) return { error: "Nesting limit reached (3 child levels)" };

        const anchor = await tx.createTask(Anchor, null, {
          ownership: { kind: "conversation" },
          background: true,
        });

        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, { model: { provider: "openai-codex", modelId: model } });
        const parentWorkspace = await tx.doc(ConversationWorkspace, parent);

        if (parentWorkspace.config) {
          const childWorkspace = await tx.doc(ConversationWorkspace, child.id);
          childWorkspace.config = {
            ...parentWorkspace.config,
            branch: `pi-hard/session-${child.id}`,
          };
        }

        const taskId = await tx.createTask(
          Delivery,
          { childId: child.id, content: input.content },
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
        };

        return { id: String(child.id), model, taskId: String(taskId) };
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
        const child = Object.values(state.children).find((value) => String(value.id) === childId);

        if (!child) return { error: "Not a direct child of this session" };
        const key = `send:${input.requestId}`;

        if (Object.hasOwn(state.deliveries, key)) {
          const existing = state.deliveries[key];

          return existing.childId === child.id && existing.content === input.content
            ? { taskId: String(existing.id) }
            : { error: "requestId already used with different target or content" };
        }

        if (Object.keys(state.deliveries).length >= MAX_DELIVERIES)
          return { error: "Delivery limit reached (32 per session)" };

        const taskId = await tx.createTask(
          Delivery,
          { childId: child.id, content: input.content },
          {
            conversationId: child.id,
            ownership: { kind: "conversation" },
            background: true,
          },
        );

        state.deliveries[key] = { id: taskId, childId: child.id, content: input.content };

        return { taskId: String(taskId) };
      }, context),
    );
  });

  list = Effect.fn("Coordination.list")(function* (this: Coordination, parent: ConversationId) {
    const state = yield* attempt("children.read", () =>
      this.harness.snapshot(Children, parent, BACKGROUND_CONTEXT),
    );

    return {
      children: Object.values(state?.children ?? {}).map(({ id, model, taskId }) => ({
        id: String(id),
        model,
        taskId: String(taskId),
      })),
    };
  });

  receipt = Effect.fn("Coordination.receipt")(function* (
    this: Coordination,
    parent: ConversationId,
    taskId: string,
    wait: boolean,
    context = BACKGROUND_CONTEXT,
  ) {
    const state = yield* attempt("deliveries.read", () =>
      this.harness.snapshot(Children, parent, context),
    );

    const delivery = Object.values(state?.deliveries ?? {}).find(
      (value) => String(value.id) === taskId,
    );

    if (!delivery) return { error: "Task not found in this session" };

    const task = yield* attempt("delivery.status", () =>
      wait
        ? this.harness.waitForTask(delivery.id, context)
        : this.harness.getTask(delivery.id, context),
    );

    if (!task) return { error: "Task not found" };

    return {
      taskId: String(task.id),
      childId: String(delivery.childId),
      status: task.state.status,
      outcome: task.state.status === "terminal" ? task.state.outcome.status : undefined,
      result: task.state.status === "terminal" ? task.state.outcome.result : undefined,
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

    const child = Object.values(state?.children ?? {}).find(
      (value) => String(value.id) === childId,
    );

    if (!child) return { error: "Not a direct child of this session" };

    const conversation = yield* attempt("child.open", () =>
      this.harness.conversation(child.id, context),
    );

    if (conversation)
      yield* attempt("child.abort", () => conversation.abort(context, { background: true }));

    return { state: "aborted" };
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

    return [
      defineTool({
        name: "spawn_task",
        description:
          "Start a child agent with its own sandbox. Returns id and taskId immediately. Inherits your model unless model is supplied. Limits: 3 child levels, 8 children per session. Use wait_for_task for its answer.",
        parameters: obj({ content: str({ minLength: 1, maxLength: 32_768 }), model: opt(str()) }),
        replay: "safe",
        executionMode: "sequential",
        execute: (input, api, context) =>
          reply(
            Schema.decodeUnknownEffect(ChildRequest)({
              ...input,
              requestId: `tool:${api.taskId}`,
            }).pipe(Effect.flatMap((parsed) => this.spawn(api.conversationId, parsed, context))),
            context,
          ),
      }),
      defineTool({
        name: "send_to_session",
        description:
          "Send a follow-up to a direct child. Returns a taskId; use wait_for_task for the answer.",
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
            ),
            context,
          ),
      }),
      defineTool({
        name: "wait_for_task",
        description:
          "Wait for one of your child delivery tasks to finish and return its answer or failure. Survives restarts. Does not wait on unrelated sessions.",
        parameters: obj({ taskId: str() }),
        replay: "safe",
        execute: ({ taskId }, api, context) =>
          reply(this.receipt(api.conversationId, taskId, true, context), context),
      }),
      defineTool({
        name: "list_children",
        description: "List your direct children's ids, models and initial taskIds.",
        parameters: obj({}),
        replay: "safe",
        execute: (_, api, context) => reply(this.list(api.conversationId), context),
      }),
      defineTool({
        name: "task_status",
        description: "Get a child delivery task's durable status and answer without waiting.",
        parameters: obj({ taskId: str() }),
        replay: "safe",
        execute: ({ taskId }, api, context) =>
          reply(this.receipt(api.conversationId, taskId, false, context), context),
      }),
      defineTool({
        name: "cancel_task",
        description:
          "Stop a direct child, its pending deliveries and all descendants. The child can receive new messages afterwards.",
        parameters: obj({ id: str() }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: ({ id }, api, context) =>
          reply(this.cancel(api.conversationId, id, context), context),
      }),
    ];
  }
}
