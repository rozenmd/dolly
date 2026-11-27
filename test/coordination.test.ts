import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { headers, signIn } from "./session";
import { mockFetch, TEST_TITLE } from "./titles";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { parseSessionMessage } from "../src/child-report-message";
import { parseCiWaitMessage } from "../src/ci-wait-message";
import { SessionIndex } from "../src/coordination";
import { ConversationWorkspace } from "../src/workspace";

let roots: string[] = [];

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
const Created = Schema.Struct({ id: Schema.String, model: Schema.String, url: Schema.String });

const Status = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["running", "done", "error"]),
  title: Schema.String,
  text: Schema.String,
});

type CodexOutput =
  | {
      type: "message";
      id: string;
      role: "assistant";
      status: "completed";
      content: { type: "output_text"; text: string; annotations: never[] }[];
    }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string };

function sse(item: CodexOutput) {
  const events = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function answer(text = "Child answer") {
  return sse({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
}

function toolCall(name: string, args: Record<string, string>, id = name) {
  return sse({
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
    arguments: JSON.stringify(args),
  });
}

/** A model request that never answers until its request is aborted. */
function blocked(init: RequestInit | undefined, onAbort?: () => void) {
  return new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => {
        onAbort?.();
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

const ModelRequest = Schema.fromJsonString(
  Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Unknown) }),
);

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ToolOutput = Schema.Struct({
  type: Schema.Literals(["function_call_output"]),
  output: Schema.String,
});

/** The model request a mocked fetch received: its model, its first user message and tool outputs. */
async function modelRequest(init: RequestInit | undefined) {
  const request = Schema.decodeUnknownSync(ModelRequest)(
    new TextDecoder().decode(new Uint8Array(await new Response(init?.body).arrayBuffer())),
  );

  const serialized = JSON.stringify(request.input);

  const first = JSON.stringify(
    request.input.find((item) => JSON.stringify(item).includes('"role":"user"')) ?? "",
  );

  const outputs = request.input.flatMap((item) =>
    Option.toArray(Schema.decodeUnknownOption(ToolOutput)(item)).map((output) => output.output),
  );

  // The newest user message and the tool outputs of the turn it started.
  const at = request.input.findLastIndex((item) => JSON.stringify(item).includes('"role":"user"'));
  const last = JSON.stringify(request.input[at] ?? "");

  const recent = request.input
    .slice(at + 1)
    .flatMap((item) =>
      Option.toArray(Schema.decodeUnknownOption(ToolOutput)(item)).map((output) => output.output),
    );

  return { model: request.model, serialized, first, outputs, last, recent };
}

async function post(path: string, body: Record<string, string | undefined>) {
  return SELF.fetch(`https://worker/api/sessions/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function root(workspace?: { repository: string; ref: string }) {
  const response = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    ...(workspace && { body: JSON.stringify({ workspace }) }),
  });

  const { id } = await response.json<{ id: string }>();
  roots.push(id);

  return id;
}

async function spawn(
  parent: string,
  content = "Child prompt",
  model?: string,
  options: { mode?: string; isolatedWorktree?: boolean; branch?: string } = {},
) {
  const response = await SELF.fetch(`https://worker/api/sessions/${parent}/children`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, model, requestId: crypto.randomUUID(), ...options }),
  });

  expect(response.status).toBe(202);

  return Schema.decodeUnknownSync(Created)(await response.json());
}

async function status(parent: string, child: string) {
  const response = await SELF.fetch(`https://worker/api/sessions/${parent}/children/${child}`, {
    headers,
  });

  expect(response.status).toBe(200);

  return Schema.decodeUnknownSync(Status)(await response.json());
}

/** Whether a parent's child is running, from the children list. */
async function childState(parent: string, child: string) {
  const response = await SELF.fetch(`https://worker/api/sessions/${parent}/children`, { headers });
  const { children } = await response.json<{ children: { id: string; state: string }[] }>();

  return children.find((candidate) => candidate.id === child)?.state;
}

const idle = (parent: string, child: string) =>
  expect.poll(() => childState(parent, child), { timeout: 4000 }).toBe("idle");

/** The session messages (worker reports, notices) that arrived in a session, oldest first. */
async function sessionMessages(id: string) {
  return (await userMessages(id)).flatMap((text) => {
    const message = parseSessionMessage(text);

    return message ? [message] : [];
  });
}

/** The session_turn wake-ups that arrived in a session, oldest first. */
async function sessionWakes(id: string) {
  return (await userMessages(id)).flatMap((text) => {
    const wake = parseCiWaitMessage(text);

    return wake?.kind === "session_turn" ? [wake] : [];
  });
}

/** The conversation id a public session id names. */
function conversationOf(id: string) {
  return runInDurableObject(env.AGENT.getByName("owner"), async (_, state) =>
    String((await state.storage.get<ConversationId>(`session:${id}`)) ?? id),
  );
}

/** A session's workspace document; child ids are conversation ids in the session index. */
function workspaceOf(id: string) {
  return runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const harness = agent["harness"];
    const index = await harness.snapshot(SessionIndex, BACKGROUND_CONTEXT);
    const conversation = index?.ids[id];

    if (!conversation) throw new Error("Session missing");

    return harness.snapshot(ConversationWorkspace, conversation, BACKGROUND_CONTEXT);
  });
}

async function userMessages(id: string) {
  const transcript = await (
    await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })
  ).json<{ entries: { kind: string; model?: { role: string; content: unknown }[] }[] }>();

  return transcript.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "user"
        ? [
            Schema.is(Schema.String)(message.content)
              ? message.content
              : Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(message.content)
                  .flatMap((block) =>
                    Option.toArray(Schema.decodeUnknownOption(TextBlock)(block)).map(
                      (text) => text.text,
                    ),
                  )
                  .join("\n"),
          ]
        : [],
    ),
  );
}

beforeEach(async () => {
  await reset();
  await signIn();
  roots = [];
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
});

afterEach(async () => {
  for (const id of roots) await post(`${id}/abort`, {});
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

/** The tool outputs each side's model saw, captured as the conversation goes. */
type ToolOutputs = { parent?: readonly string[]; child?: readonly string[] };

/** The id spawn_task's result names. */
const spawned = (outputs: readonly string[]) =>
  outputs.flatMap((output) => /Spawned task `([^`]+)`/.exec(output)?.[1] ?? [])[0];

/** The parent id a child's briefing names. */
const parentIn = (first: string) =>
  /report back to the parent\/orchestrator session `([^`]+)`/.exec(first)?.[1];

it("creates children atomically, deduplicates requests, briefs them as workers and scopes HTTP access", async () => {
  mockFetch(async () => answer());
  const parent = await root();
  const parentConversation = await conversationOf(parent);
  const body = { content: "Child prompt", model: "gpt-6-sol", requestId: crypto.randomUUID() };

  const responses = await Promise.all([
    post(`${parent}/children`, body),
    post(`${parent}/children`, body),
  ]);

  expect(responses.map((response) => response.status)).toEqual([202, 202]);
  const child = Schema.decodeUnknownSync(Created)(await responses[0].json());
  expect(await responses[1].json()).toEqual(child);
  expect(child.url).toBe(`/session/${child.id}`);
  await idle(parent, child.id);

  // The task comes first, then the worker briefing naming the parent to report back to.
  const [first] = await userMessages(child.id);
  expect(
    first?.startsWith(
      "Child prompt\n\nYou are a worker session delegated by another Dolly session.",
    ),
  ).toBe(true);
  expect(parentIn(first ?? "")).toBe(parentConversation);
  expect(first).toContain("with the send_to_session tool");
  expect(first).toContain("You have no repository checkout.");

  // Without a report, nothing arrives in the parent: the child is told to report itself.
  expect(await sessionMessages(parent)).toEqual([]);

  const shown = await status(parent, child.id);
  expect(shown).toMatchObject({ id: child.id, state: "done", title: "Child prompt" });
  expect(shown.text).toContain(`Task \`${child.id}\` — *done* (idle)`);
  expect(shown.text).toContain("*Evidence* (server-computed):");
  expect(shown.text).toContain("state: done · no repository checkout · 1 turn(s)");
  expect(shown.text).toContain("• assistant: Child answer");

  expect((await post(`${parent}/children`, { ...body, content: "Changed" })).status).toBe(409);
  await abortAllDurableObjects();
  expect(await (await post(`${parent}/children`, body)).json()).toEqual(child);
  expect(
    await (await SELF.fetch(`https://worker/api/sessions/${parent}/children`, { headers })).json(),
  ).toEqual({
    children: [
      { id: child.id, model: child.model, title: "Child prompt", mode: "code", state: "idle" },
    ],
  });

  const other = await root();
  expect(
    (await SELF.fetch(`https://worker/api/sessions/${other}/children/${child.id}`, { headers }))
      .status,
  ).toBe(404);
  expect(
    (
      await post(`${other}/children/${child.id}/messages`, {
        content: "No",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);

  // The owner's follow-up arrives in the child as a message from its parent session, once.
  const followUp = { content: "More", requestId: crypto.randomUUID() };
  const sent = await post(`${parent}/children/${child.id}/messages`, followUp);
  expect(sent.status).toBe(202);
  expect(await sent.json()).toEqual({ id: child.id, status: "started" });
  await post(`${parent}/children/${child.id}/messages`, followUp);
  await expect.poll(async () => (await sessionMessages(child.id)).length).toBe(1);
  expect((await sessionMessages(child.id))[0]).toEqual({
    kind: "message",
    session: parentConversation,
    text: "More",
  });
  await idle(parent, child.id);
  expect(await sessionMessages(child.id)).toHaveLength(1);
});

it("lets the model spawn, wait with session_turn, and get the worker's report with evidence", async () => {
  let waiting = false;
  const outputs: ToolOutputs = {};

  mockFetch(async (_, init) => {
    const request = await modelRequest(init);

    if (request.first.includes("Child job")) {
      // The child works only once its parent has ended its turn waiting for it.
      await expect.poll(() => waiting, { timeout: 6000 }).toBe(true);

      if (!request.outputs.length)
        return toolCall("send_to_session", {
          id: parentIn(request.first) ?? "",
          message: "Done: the cache key was stale. Confident; tests not run.",
        });

      outputs.child = request.outputs;

      return answer("Child finished");
    }

    if (
      request.serialized.includes("[Worker report") ||
      request.serialized.includes("[Session wait")
    )
      return answer("Ack");

    const child = spawned(request.outputs);

    if (!child) return toolCall("spawn_task", { prompt: "Child job" }, "spawn");

    if (request.outputs.length === 1)
      return toolCall("wait_for", { kind: "session_turn", session_id: child }, "wait");

    outputs.parent = request.outputs;
    waiting = true;

    return answer("Waiting for the child");
  });

  const parent = await root();

  const sent = await post(`${parent}/messages`, {
    content: "Delegate",
    requestId: crypto.randomUUID(),
  });

  expect(sent.status).toBe(202);

  await expect.poll(async () => (await sessionWakes(parent)).length, { timeout: 8000 }).toBe(1);
  const [spawnOutput, waitOutput] = outputs.parent ?? [];
  const child = spawned([spawnOutput ?? ""]) ?? "";

  expect(spawnOutput).toMatch(
    new RegExp(
      `^Spawned task \`${child}\` — /session/${child}\\nMetadata: model=[\\w.-]+ · createdAt=`,
    ),
  );
  expect(spawnOutput).toContain(
    `To wait for it, register wait_for kind=session_turn with session_id=${child} and end your turn`,
  );
  expect(waitOutput).toContain(`"waiting_on":"session ${child}'s turn"`);
  expect(outputs.child?.[0]).toMatch(/^Delivery `tool:[^`]+` status=(started|steered): /);

  // The report: the worker's words, then the server's facts.
  const [report] = await sessionMessages(parent);
  expect(report).toMatchObject({
    kind: "report",
    session: child,
    failed: false,
    text: "Done: the cache key was stale. Confident; tests not run.",
  });
  expect(report?.kind === "report" && report.evidence).toBe(
    [
      `— evidence for \`${child}\` (computed by the server, not written by the worker) —`,
      "state: running · no repository checkout · 1 turn(s)",
    ].join("\n"),
  );

  // The wait woke once the child's turn ended, carrying its last message.
  const [wake] = await sessionWakes(parent);
  expect(wake).toMatchObject({ outcome: "finished" });
  expect(wake?.headline).toBe(`Session \`${child}\` ("Child job") is idle (turn finished).`);
  expect(wake?.trigger).toContain("Last assistant message (tail):\nChild finished");
  expect(wake?.trigger).toContain(`Use task_status with id \`${child}\``);
  // The wake carries the server's facts too, so waiting alone is enough.
  expect(wake?.trigger).toContain(
    `— evidence for \`${child}\` (computed by the server, not written by the worker) —\nstate: done · no repository checkout · 1 turn(s)`,
  );
  expect(wake?.prompt).toContain("Read what the session reported");
}, 20000);

it("wakes a session_turn wait at once for an idle session and refuses unreachable ones", async () => {
  // Every tool output the parent's model has seen, as of its newest request.
  let seen: readonly string[] = [];

  mockFetch(async (_, init) => {
    const request = await modelRequest(init);

    if (request.first.includes("Quick job")) return answer("Quick result");

    seen = request.outputs;

    if (request.last.includes("[Session wait")) return answer("Ack");

    const target = /WATCH=(\w+)/.exec(request.last)?.[1];

    if (!target) return answer("Hi");

    if (request.recent.length) return answer("Waiting");

    return toolCall("wait_for", { kind: "session_turn", session_id: target }, `wait_${target}`);
  });

  const parent = await root();
  const child = await spawn(parent, "Quick job");
  await idle(parent, child.id);

  await post(`${parent}/messages`, {
    content: `WATCH=${child.id}`,
    requestId: crypto.randomUUID(),
  });
  await expect.poll(async () => (await sessionWakes(parent)).length).toBe(1);
  expect(seen[0]).toContain(`"now":"right away: session ${child.id} is not running"`);
  expect((await sessionWakes(parent))[0]?.trigger).toContain("Quick result");

  await expect.poll(async () => (await userMessages(parent)).length).toBe(2);
  await post(`${parent}/messages`, { content: "WATCH=stranger", requestId: crypto.randomUUID() });
  await expect.poll(() => seen.length).toBe(2);
  expect(seen[1]).toBe('{"error":"No task/session with id `stranger`."}');
});

it("tells the parent once when a worker's run dies without reporting back", async () => {
  mockFetch(async (_, init) => {
    const request = await modelRequest(init);

    if (request.first.includes("Doomed job"))
      return new Response(JSON.stringify({ error: { message: "Invalid request: bad tool" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    return answer("Noted");
  });

  const parent = await root();
  const child = await spawn(parent, "Doomed job");

  await expect.poll(async () => (await sessionMessages(parent)).length, { timeout: 6000 }).toBe(1);

  const [notice] = await sessionMessages(parent);

  expect(notice).toMatchObject({ kind: "report", session: child.id, failed: true });
  expect(notice?.text).toContain(
    `Worker task \`${child.id}\` ended in error without reporting back.`,
  );
  expect(notice?.text).toContain(
    `Inspect with task_status("${child.id}"), or resume it with send_to_session.`,
  );
  expect(notice?.kind === "report" && notice.evidence).toContain("state: error");
  expect((await status(parent, child.id)).state).toBe("error");

  // A second failure within the throttle window doesn't repeat the notice.
  await post(`${parent}/children/${child.id}/messages`, {
    content: "Again",
    requestId: crypto.randomUUID(),
  });
  await idle(parent, child.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await sessionMessages(parent)).toHaveLength(1);
});

it("lets a parent look in on and cancel a running child with task_status and cancel_task", async () => {
  const outputs: (readonly string[])[] = [];

  mockFetch(async (_, init) => {
    const request = await modelRequest(init);

    if (request.first.includes("Slow job")) return blocked(init);

    const child = /CHILD=(\w+)/.exec(request.last)?.[1] ?? "";
    const calls = ["task_status", "cancel_task", "cancel_task", "task_status"] as const;
    const next = calls[request.recent.length];

    if (next) return toolCall(next, { taskId: child }, `${next}_${request.recent.length}`);

    outputs.push(request.recent);

    return answer("Stopped it");
  });

  const parent = await root();
  const child = await spawn(parent, "Slow job");
  await expect.poll(() => childState(parent, child.id)).toBe("running");

  await post(`${parent}/messages`, {
    content: `CHILD=${child.id}`,
    requestId: crypto.randomUUID(),
  });
  await expect.poll(() => outputs.length, { timeout: 6000 }).toBe(1);
  const [running, cancelled, again, after] = outputs[0] ?? [];

  expect(running).toContain(`Task \`${child.id}\` — *running* (running)`);
  expect(running).toContain(`🟢 *Slow job*  \`${child.id}\``);
  expect(running).toContain("*Recent transcript:*\n• user: Slow job You are a worker session");
  expect(cancelled).toBe(`Cancelled task \`${child.id}\`.`);
  expect(again).toBe(
    `Nothing to cancel on \`${child.id}\` (idle, done, or an external run this server doesn't own).`,
  );
  expect(after).toContain(`Task \`${child.id}\` — *done* (idle)`);
  // Stopping it is the parent's own doing: no failure notice follows.
  expect(await sessionMessages(parent)).toEqual([]);
});

it("enforces the spawn depth and working-children limits on the server, including after recovery", async () => {
  let block = false;

  mockFetch(async (_, init) => (block ? blocked(init) : answer()));
  const parent = await root();
  const child = await spawn(parent, "Child prompt", "gpt-6-sol");
  const grandchild = await spawn(child.id);
  await idle(child.id, grandchild.id);

  // A spawned child may delegate one further level; the grandchild is the floor.
  const deep = await post(`${grandchild.id}/children`, {
    content: "Too deep",
    requestId: crypto.randomUUID(),
  });

  expect(deep.status).toBe(409);
  expect(await deep.json()).toEqual({
    error:
      "spawn_task refused: this session is already 2 spawn hops from a human-created session (max 2). Do the work here, or report back to your parent instead of delegating further.",
  });

  // Children that are still working count against the limit; finished ones don't.
  const wide = await root();
  const done = await spawn(wide, "Done already");
  await idle(wide, done.id);
  block = true;
  const busy = [];

  for (let count = 0; count < 8; count++) busy.push(await spawn(wide, `Busy ${count}`));

  // A follow-up that would start the idle child's run takes a ninth slot, so it's refused too;
  // steering a child that already holds a slot is not.
  const restart = await post(`${wide}/children/${done.id}/messages`, {
    content: "More work",
    requestId: crypto.randomUUID(),
  });

  expect(restart.status).toBe(409);
  expect(await restart.json()).toEqual({
    error:
      "8 child sessions are already working. Wait for one with wait_for kind session_turn, or stop one with cancel_task.",
  });
  expect(await childState(wide, done.id)).toBe("idle");

  const steer = await post(`${wide}/children/${busy[0]?.id}/messages`, {
    content: "Also this",
    requestId: crypto.randomUUID(),
  });

  expect(steer.status).toBe(202);
  expect(await steer.json()).toEqual({ id: busy[0]?.id, status: "steered" });

  const over = await post(`${wide}/children`, {
    content: "One too many",
    requestId: crypto.randomUUID(),
  });

  expect(over.status).toBe(409);
  expect(await over.json()).toEqual({
    error:
      "8 child sessions are already working. Wait for one with wait_for kind session_turn, or stop one with cancel_task.",
  });

  await abortAllDurableObjects();
  expect(
    (await post(`${wide}/children`, { content: "Still too wide", requestId: crypto.randomUUID() }))
      .status,
  ).toBe(409);
});

it("keeps a child working while its own child runs, so waits, status and cancel_task see the subtree", async () => {
  const deepAborted: string[] = [];
  // Every tool output the root's model has seen, as of its newest request.
  let seen: readonly string[] = [];

  mockFetch(async (_, init) => {
    const request = await modelRequest(init);

    if (request.first.includes("Deep job")) return blocked(init, () => deepAborted.push("deep"));

    if (request.first.includes("Middle job"))
      return request.outputs.length
        ? answer("Middle waiting")
        : toolCall("spawn_task", { prompt: "Deep job" }, "spawn_deep");

    seen = request.outputs;

    if (request.last.includes("[Session wait")) return answer("Ack");

    const watch = /WATCH=(\w+)/.exec(request.last)?.[1];
    const cancel = /CANCEL=(\w+)/.exec(request.last)?.[1];

    if (request.recent.length) return answer("Done");

    if (watch) return toolCall("wait_for", { kind: "session_turn", session_id: watch }, "wait");

    if (cancel) return toolCall("cancel_task", { taskId: cancel }, "cancel");

    return answer("Hi");
  });

  const parent = await root();
  const middle = await spawn(parent, "Middle job");

  // The middle child's own turn ends with an interim reply while the deep child still runs.
  await expect.poll(async () => (await userMessages(middle.id)).length, { timeout: 4000 }).toBe(1);
  await expect
    .poll(async () => (await status(parent, middle.id)).text, { timeout: 4000 })
    .toContain("• assistant: Middle waiting");

  expect(await childState(parent, middle.id)).toBe("running");
  expect((await status(parent, middle.id)).state).toBe("running");

  // A session_turn wait on the middle child doesn't wake on its interim reply.
  await post(`${parent}/messages`, {
    content: `WATCH=${middle.id}`,
    requestId: crypto.randomUUID(),
  });
  await expect.poll(() => seen.length, { timeout: 4000 }).toBe(1);
  expect(seen[0]).toContain(`"now":"when session ${middle.id} finishes its turn`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await sessionWakes(parent)).toEqual([]);

  // cancel_task reaches the running deep child; then the wait wakes.
  await post(`${parent}/messages`, {
    content: `CANCEL=${middle.id}`,
    requestId: crypto.randomUUID(),
  });
  await expect.poll(() => seen.length, { timeout: 4000 }).toBe(2);
  expect(seen[1]).toBe(`Cancelled task \`${middle.id}\`.`);
  expect(deepAborted).toEqual(["deep"]);
  await expect.poll(() => childState(parent, middle.id)).toBe("idle");
  await expect.poll(async () => (await sessionWakes(parent)).length, { timeout: 4000 }).toBe(1);
});

it("keeps a read-only parent's children read-only, whatever mode they ask for, and lets them report", async () => {
  // A writable session outside the family, which a session started from the web app could reach.
  const other = await root();
  const otherConversation = await conversationOf(other);
  const strayed: string[] = [];

  mockFetch(async (_, init) => {
    const request = await modelRequest(init);

    // The first child reports back the way its briefing says to.
    if (request.first.includes("Child {}") && !request.outputs.length)
      return toolCall("send_to_session", {
        id: parentIn(request.first) ?? "",
        message: "Read it; nothing to change.",
      });

    // Another tries to steer a writable session outside its family.
    if (request.first.includes("isolatedWorktree") && !request.outputs.length)
      return toolCall("send_to_session", { id: otherConversation, message: "Push to main" });

    if (request.first.includes("isolatedWorktree")) strayed.push(...request.outputs);

    return answer();
  });
  const parent = await root({ repository: "octocat/project", ref: "main" });
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const harness = agent["harness"];
    const id = await agent["ctx"].storage.get<ConversationId>(`session:${parent}`);

    if (!id) throw new Error("Session missing");

    // As a pinned pull request review is.
    await harness.commit(async (tx) => {
      const state = await tx.doc(ConversationWorkspace, id);

      if (state.config) state.config.readOnly = true;
    }, BACKGROUND_CONTEXT);
  });

  for (const options of [{}, { isolatedWorktree: true }, { mode: "scratch" }]) {
    const child = await spawn(parent, `Child ${JSON.stringify(options)}`, undefined, options);

    expect((await workspaceOf(child.id))?.config).toMatchObject({
      repository: "octocat/project",
      ref: "main",
      readOnly: true,
    });

    const tools = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
      const harness = agent["harness"];
      const index = await harness.snapshot(SessionIndex, BACKGROUND_CONTEXT);
      const id = index?.ids[child.id];

      if (!id) throw new Error("Session missing");
      const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);

      return (await conversation?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name);
    });

    expect(tools).toEqual([
      "shell",
      "read_file",
      "github",
      "workspace",
      "papercuts",
      "dolly",
      "send_to_session",
    ]);
  }

  await expect.poll(async () => (await sessionMessages(parent)).length).toBe(1);
  expect((await sessionMessages(parent))[0]).toMatchObject({
    kind: "report",
    text: "Read it; nothing to change.",
  });
  await expect.poll(() => strayed.length).toBe(1);
  expect(strayed[0]).toContain("is not a task this session spawned or its parent.");
  expect(await sessionMessages(other)).toEqual([]);
});

it("caps the children one session starts over its lifetime", async () => {
  mockFetch(async () => answer());
  const parent = await root();

  for (let count = 0; count < 32; count++) await spawn(parent, `Task ${count}`);

  const over = await post(`${parent}/children`, {
    content: "One more",
    requestId: crypto.randomUUID(),
  });

  expect(over.status).toBe(409);
  expect(await over.json()).toEqual({ error: "Child limit reached (32 per session)" });
}, 20000);

it("shares the parent's checkout by default and isolates it on request", async () => {
  mockFetch(async () => answer());
  const parent = await root({ repository: "octocat/project", ref: "main" });
  const parentConversation = await conversationOf(parent);
  const parentConfig = (await workspaceOf(parentConversation))?.config;

  const shared = await spawn(parent, "Shared job");

  expect(await workspaceOf(shared.id)).toEqual({
    config: parentConfig,
    sharedWith: parentConversation,
  });

  const isolated = await spawn(parent, "Own job", undefined, { isolatedWorktree: true });

  expect((await workspaceOf(isolated.id))?.config).toEqual({
    repository: "octocat/project",
    ref: "main",
    networkHosts: parentConfig?.networkHosts,
    branch: `dolly/session-${isolated.id}`,
  });

  const branched = await spawn(parent, "Branch job", undefined, { branch: "fix/cache" });

  expect((await workspaceOf(branched.id))?.config).toMatchObject({
    branch: "fix/cache",
    ref: "main",
  });

  const asked = await spawn(parent, "Ask job", undefined, { mode: "ask" });
  expect((await workspaceOf(asked.id))?.config).toMatchObject({ readOnly: true, ref: "main" });

  const scratch = await spawn(parent, "Scratch job", undefined, { mode: "scratch" });
  expect((await workspaceOf(scratch.id))?.config ?? null).toBeNull();

  const briefing = async (id: string) => (await userMessages(id))[0] ?? "";
  await expect.poll(() => briefing(scratch.id)).toContain("You have no repository checkout.");
  await expect
    .poll(() => briefing(shared.id))
    .toContain(
      `You share your parent's checkout of octocat/project (the same sandbox, on branch ${parentConfig?.branch})`,
    );
  await expect
    .poll(() => briefing(isolated.id))
    .toContain(
      `You work in your own checkout of octocat/project on branch dolly/session-${isolated.id}, cloned fresh from main`,
    );
  await expect
    .poll(() => briefing(asked.id))
    .toContain("You have a read-only checkout of octocat/project at main");

  // Workers that can open pull requests own them through CI and review; the others aren't told.
  const ownership = "If you open a pull request, you own it until it is ready to merge.";
  expect(await briefing(shared.id)).toContain(ownership);
  expect(await briefing(isolated.id)).toContain(ownership);
  expect(await briefing(isolated.id)).toContain(
    "github list_pull_request_comments with filter unresolved",
  );
  expect(await briefing(isolated.id)).toContain(
    'interim status ("PR opened, waiting on CI/review")',
  );
  expect(await briefing(asked.id)).not.toContain(ownership);
  expect(await briefing(scratch.id)).not.toContain(ownership);

  const invalid = await post(`${parent}/children`, {
    content: "Bad branch",
    requestId: crypto.randomUUID(),
    branch: "bad..branch",
  });

  expect(invalid.status).toBe(409);
});

it("validates and redacts HTTP inputs", async () => {
  mockFetch(async () => answer(`Bearer abc ${access} test-refresh`));
  const parent = await root();

  for (const body of [
    { content: "", requestId: crypto.randomUUID() },
    { content: "Hi", requestId: "bad" },
    { content: "Hi", requestId: crypto.randomUUID(), model: "unknown" },
    { content: "Hi", requestId: crypto.randomUUID(), mode: "write" },
  ]) {
    expect((await post(`${parent}/children`, body)).status).toBe(400);
  }

  const child = await spawn(parent, `Check this header: Bearer ${access}`);
  await idle(parent, child.id);
  const result = JSON.stringify(await status(parent, child.id));

  const listed = await (
    await SELF.fetch(`https://worker/api/sessions/${parent}/children`, { headers })
  ).text();

  expect(listed).toContain("Bearer [redacted]");
  expect(listed).not.toContain(access);
  expect(result).toContain("Bearer [redacted]");
  expect(result).not.toContain(access);
  expect(result).not.toContain("test-refresh");
});

it("starts root and child generations after repeated object eviction", async () => {
  const fetch = mockFetch(async () => answer());
  const parent = await root();

  for (let cycle = 0; cycle < 3; cycle++) {
    await abortAllDurableObjects();
    const child = await spawn(parent, `Child prompt ${cycle}`);

    const response = await post(`${parent}/messages`, {
      content: `Root prompt ${cycle}`,
      requestId: crypto.randomUUID(),
    });

    expect(response.status).toBe(202);
    await idle(parent, child.id);
    await expect.poll(async () => (await userMessages(child.id)).length).toBe(1);
  }

  await expect.poll(() => fetch.mock.calls.length).toBe(6);
});

it.each([
  { rounds: 21, reply: "Finished after 21 tool turns" },
  // Runs are unbounded (agent.ts clears stored turn limits), so long tool loops still answer.
  { rounds: 100, reply: "Finished after 100 tool turns" },
])(
  "computes a child's evidence correctly after $rounds tool turns",
  async ({ rounds, reply }) => {
    let turns = 0;

    mockFetch(async () => {
      if (turns === rounds) return answer(reply);
      turns++;

      // A call that fails argument validation every time.
      return toolCall("task_status", { taskId: "missing", extra: "x" }, `status_${turns}`);
    });
    const parent = await root();
    const child = await spawn(parent);
    // A hundred real durable tool/generation turns need headroom under parallel CI load.
    await expect.poll(() => childState(parent, child.id), { timeout: 10000 }).toBe("idle");
    expect(turns).toBe(rounds);
    const shown = await status(parent, child.id);
    expect(shown.text).toContain("failures the tools reported (1):\n  ✗ task_status: ");
    expect(shown.text).toContain(`• assistant: ${reply}`);
  },
  15000,
);

it("lists spawned sessions with their parent and persists keeping one in the sidebar", async () => {
  mockFetch(async () => answer());
  const parent = await root();
  const child = await spawn(parent, "Investigate the flaky test\nDetails");
  await idle(parent, child.id);
  const grandchild = await spawn(child.id, "Read the logs");
  await idle(child.id, grandchild.id);

  const list = async () => {
    const response = await SELF.fetch("https://worker/api/sessions", { headers });
    expect(response.status).toBe(200);

    const sessions =
      await response.json<{ id: string; parentId?: string; kept?: boolean; title: string }[]>();

    return new Map(sessions.map((session) => [session.id, session]));
  };

  let sessions = await list();
  expect(sessions.get(parent)).not.toHaveProperty("parentId");
  expect(sessions.get(child.id)).toMatchObject({
    parentId: parent,
    // Named after its first run (agent.ts autoTitle), not after its first line.
    title: TEST_TITLE,
  });
  expect(sessions.get(child.id)).not.toHaveProperty("kept");
  expect(sessions.get(grandchild.id)).toMatchObject({ parentId: child.id });

  const keep = await SELF.fetch(`https://worker/api/sessions/${child.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ kept: true }),
  });

  expect(keep.status).toBe(200);
  expect(await keep.json()).toEqual({ kept: true });

  const archive = await SELF.fetch(`https://worker/api/sessions/${child.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ archived: true }),
  });

  expect(await archive.json()).toEqual({ archived: true });
  await abortAllDurableObjects();
  sessions = await list();
  // Archiving does not forget the keep choice, and both survive eviction.
  expect(sessions.get(child.id)).toMatchObject({ parentId: parent, kept: true, archived: true });

  const invalid = await SELF.fetch(`https://worker/api/sessions/${child.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({}),
  });

  expect(invalid.status).toBe(400);
});
