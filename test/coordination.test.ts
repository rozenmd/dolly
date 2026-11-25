import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { headers, signIn } from "./session";
import { parseChildReportMessage } from "../src/child-report-message";

let roots: string[] = [];

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
const Created = Schema.Struct({ id: Schema.String, model: Schema.String });

const Status = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["working", "idle", "stopped"]),
  last_turn: Schema.optional(Schema.String),
  latest_reply: Schema.optional(Schema.String),
  since_last_report: Schema.String,
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

  return { model: request.model, serialized, first, outputs };
}

async function post(path: string, body: Record<string, string | undefined>) {
  return SELF.fetch(`https://worker/api/sessions/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function root() {
  const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await response.json<{ id: string }>();
  roots.push(id);

  return id;
}

async function spawn(parent: string, content = "Child prompt", model?: string) {
  const response = await post(`${parent}/children`, {
    content,
    model,
    requestId: crypto.randomUUID(),
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

const idle = (parent: string, child: string) =>
  expect.poll(async () => (await status(parent, child)).state, { timeout: 4000 }).toBe("idle");

/** The child reports that arrived in a session, oldest first. */
async function reports(id: string) {
  const transcript = await (
    await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })
  ).json<{ entries: { kind: string; model?: { role: string; content: unknown }[] }[] }>();

  return transcript.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (message.role !== "user") return [];

      const text = Schema.is(Schema.String)(message.content)
        ? message.content
        : JSON.stringify(message.content);

      const report = parseChildReportMessage(text);

      return report ? [report] : [];
    }),
  );
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
              : JSON.stringify(message.content),
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

it("creates children atomically, deduplicates requests, reports back and scopes messaging", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
  const parent = await root();
  const body = { content: "Child prompt", model: "gpt-6-sol", requestId: crypto.randomUUID() };

  const responses = await Promise.all([
    post(`${parent}/children`, body),
    post(`${parent}/children`, body),
  ]);

  expect(responses.map((response) => response.status)).toEqual([202, 202]);
  const child = Schema.decodeUnknownSync(Created)(await responses[0].json());
  expect(await responses[1].json()).toEqual(child);
  await idle(parent, child.id);
  expect(await status(parent, child.id)).toMatchObject({
    last_turn: "answered",
    latest_reply: "Child answer",
  });

  // The child's answer arrives in the parent as a report, which the parent then answers.
  await expect.poll(async () => (await reports(parent)).length).toBe(1);
  expect((await reports(parent))[0]).toMatchObject({
    child: child.id,
    outcome: "answered",
    headline: "Child answer",
    task: "Child prompt",
    reply: "Child answer",
  });
  expect((await reports(parent))[0]?.evidence).toContain("- Tool calls: 0");
  await expect.poll(() => fetch.mock.calls.length).toBe(2);

  // The child was told it is a worker and that its final reply is its report.
  const [first] = await userMessages(child.id);
  expect(first).toContain("Child prompt");
  expect(first).toContain("You are a child session that another Dolly session (your parent)");
  expect(first).toContain("Your final reply is your report.");

  expect((await post(`${parent}/children`, { ...body, content: "Changed" })).status).toBe(409);
  await abortAllDurableObjects();
  expect(await (await post(`${parent}/children`, body)).json()).toEqual(child);
  expect(
    await (await SELF.fetch(`https://worker/api/sessions/${parent}/children`, { headers })).json(),
  ).toEqual({
    children: [{ ...child, title: "Child prompt", state: "idle" }],
  });
  expect((await SELF.fetch(`https://worker/api/sessions/${child.id}`, { headers })).status).toBe(
    200,
  );
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
  const followUp = { content: "More", requestId: crypto.randomUUID() };
  const sent = await post(`${parent}/children/${child.id}/messages`, followUp);
  const delivery = await sent.json<{ id: string; sent: boolean }>();
  expect(sent.status).toBe(202);
  expect(delivery).toEqual({ id: child.id, sent: true });
  expect(await (await post(`${parent}/children/${child.id}/messages`, followUp)).json()).toEqual(
    delivery,
  );

  // A follow-up reports back like the first message, once.
  await expect.poll(async () => (await reports(parent)).length).toBe(2);
  await expect.poll(() => fetch.mock.calls.length).toBe(4);
});

it("starts root and child generations after repeated object eviction", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
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
    await expect.poll(async () => (await reports(parent)).length).toBe(cycle + 1);
    // The owner's prompt and the report each get an answer.
    await expect
      .poll(async () => {
        const transcript = await SELF.fetch(`https://worker/api/sessions/${parent}`, { headers });
        const text = await transcript.text();

        return text.split('"kind":"pi.assistant"').length - 1;
      })
      .toBe(2 * (cycle + 1));
  }

  expect(fetch).toHaveBeenCalledTimes(9);
});

it("enforces depth and working-children limits on the server, including after recovery", async () => {
  let block = false;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) =>
    block ? blocked(init) : answer(),
  );
  const parent = await root();
  let current = parent;

  for (let depth = 0; depth < 3; depth++) {
    const child = await spawn(current, "Child prompt", depth === 0 ? "gpt-6-sol" : undefined);
    expect(child.model).toBe("gpt-6-sol");
    await idle(current, child.id);
    current = child.id;
  }

  await abortAllDurableObjects();

  const rejected = await post(`${current}/children`, {
    content: "Too deep",
    requestId: crypto.randomUUID(),
  });

  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({
    error:
      "Nesting limit reached (3 child levels). Do the work here instead of delegating further.",
  });

  // Children that are still working count against the limit; finished ones don't.
  block = false;
  const wide = await root();
  const resting = await spawn(wide);
  await idle(wide, resting.id);
  block = true;

  for (let count = 0; count < 8; count++) await spawn(wide);

  const busy = await post(`${wide}/children`, {
    content: "Too wide",
    requestId: crypto.randomUUID(),
  });

  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({
    error: "8 child sessions are already working. Wait for a report, or stop one with cancel_task.",
  });

  // New work for an idle child would make a ninth working child too.
  const resumed = await post(`${wide}/children/${resting.id}/messages`, {
    content: "More work",
    requestId: crypto.randomUUID(),
  });

  expect(resumed.status).toBe(409);
  expect(await resumed.json()).toEqual({
    error: "8 child sessions are already working. Wait for a report, or stop one with cancel_task.",
  });

  await abortAllDurableObjects();
  expect(
    (await post(`${wide}/children`, { content: "Still too wide", requestId: crypto.randomUUID() }))
      .status,
  ).toBe(409);
});

it.each([false, true])(
  "lets the model spawn, end its turn and act on the child's report (restart=%s)",
  async (restart) => {
    let recovered = !restart;
    let childModel = "";
    const parentRequests: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const request = await modelRequest(init);

      if (request.model === "gpt-6-sol") {
        childModel = request.model;

        if (!recovered) return blocked(init);

        return answer("Delegated result");
      }

      parentRequests.push(request.serialized);

      if (request.serialized.includes("[Child report"))
        return request.serialized.includes("Delegated result")
          ? answer("Parent consumed delegated result")
          : answer("Report without the result");

      if (!request.outputs.length)
        return toolCall("spawn_task", { content: "Child job", model: "gpt-6-sol" });

      // The spawn returned at once; the parent ends its turn instead of waiting.
      expect(request.outputs.at(-1)).toContain("reports back here when its turn ends");

      return answer("Delegated; I'll act on its report.");
    });
    const parent = await root();
    expect(
      (
        await post(`${parent}/messages`, {
          content: "Delegate this",
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(202);

    // The parent's turn ends while the child still works: nothing holds it open.
    await expect
      .poll(
        async () => (await SELF.fetch(`https://worker/api/sessions/${parent}`, { headers })).text(),
        { timeout: 4000 },
      )
      .toContain("Delegated; I'll act on its report.");

    if (restart) {
      await expect.poll(() => childModel).toBe("gpt-6-sol");
      recovered = true;
      await abortAllDurableObjects();
    }

    await expect
      .poll(
        async () => (await SELF.fetch(`https://worker/api/sessions/${parent}`, { headers })).text(),
        { timeout: 4000 },
      )
      .toContain("Parent consumed delegated result");
    expect(childModel).toBe("gpt-6-sol");
    expect(await reports(parent)).toHaveLength(1);

    const listing = await (
      await SELF.fetch(`https://worker/api/sessions/${parent}/children`, { headers })
    ).json<{ children: { id: string }[] }>();

    expect(listing.children).toHaveLength(1);
    expect(
      (await userMessages(listing.children[0]?.id ?? "")).filter((text) =>
        text.includes("Child job"),
      ),
    ).toHaveLength(1);
  },
);

it("caps the children one session starts over its lifetime", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
  const parent = await root();

  for (let count = 0; count < 32; count++) {
    const child = await spawn(parent, `Child ${count}`);
    await idle(parent, child.id);
  }

  const rejected = await post(`${parent}/children`, {
    content: "One too many",
    requestId: crypto.randomUUID(),
  });

  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ error: "Child limit reached (32 per session)" });
}, 30000);

it("attaches failures a tool reported to the report", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const request = await modelRequest(init);

    if (request.serialized.includes("[Child report")) return answer("Noted");

    // The child's call fails argument validation, then it answers.
    return request.outputs.length
      ? answer("Couldn't stop it")
      : toolCall("cancel_task", { id: "missing", extra: "x" });
  });

  const parent = await root();
  const child = await spawn(parent, "Stop the stray job");
  await expect.poll(async () => (await reports(parent)).length, { timeout: 4000 }).toBe(1);
  const [report] = await reports(parent);

  expect(report).toMatchObject({ child: child.id, reply: "Couldn't stop it" });
  expect(report?.evidence).toContain("- Failures a tool reported (1):");
  expect(report?.evidence).toContain("  - cancel_task");
  expect(report?.evidence).toContain("- Tool calls: 1");
});

it("holds a subtree's report until its deepest child answers, even when a middle child ends first", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let middleAnswered = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const request = await modelRequest(init);

    if (request.first.includes("Deep job")) {
      await gate;

      return answer("Deep result");
    }

    if (request.first.includes("Middle job")) {
      if (request.serialized.includes("[Child report")) return answer("Middle summary");

      if (!request.outputs.length) return toolCall("spawn_task", { content: "Deep job" });
      middleAnswered = Date.now();

      return answer("Middle waiting");
    }

    if (request.first.includes("Top job")) {
      if (request.serialized.includes("[Child report")) return answer("Top summary");

      if (!request.outputs.length) return toolCall("spawn_task", { content: "Middle job" });

      // The middle child ends its turn before this one does.
      await expect.poll(() => middleAnswered).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 300));

      return answer("Top waiting");
    }

    return answer("Root acknowledged");
  });

  const parent = await root();
  const top = await spawn(parent, "Top job");

  await expect
    .poll(async () => (await userMessages(top.id)).length + (await status(parent, top.id)).state, {
      timeout: 6000,
    })
    .toBe("1working");
  await expect
    .poll(async () =>
      (
        await (await SELF.fetch(`https://worker/api/sessions/${top.id}`, { headers })).text()
      ).includes("Top waiting"),
    )
    .toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // The deepest child still works, so nothing has reached the root yet.
  expect(await reports(parent)).toHaveLength(0);
  expect((await status(parent, top.id)).state).toBe("working");

  release();
  await expect.poll(async () => (await reports(parent)).length, { timeout: 6000 }).toBe(1);
  expect((await reports(parent))[0]).toMatchObject({ child: top.id, reply: "Top summary" });
  await idle(parent, top.id);
  expect(await reports(parent)).toHaveLength(1);
}, 20000);

it("reports a grandchild's work through its parent once, after the grandchild answers", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const request = await modelRequest(init);

    if (request.first.includes("Grandchild job")) return answer("Grandchild result");

    if (request.first.includes("Child job")) {
      if (request.serialized.includes("[Child report")) return answer("Child summary");

      if (!request.outputs.length) return toolCall("spawn_task", { content: "Grandchild job" });

      return answer("Waiting on my child");
    }

    return answer("Root acknowledged");
  });

  const parent = await root();
  const child = await spawn(parent, "Child job");

  await expect.poll(async () => (await reports(parent)).length, { timeout: 6000 }).toBe(1);

  const [report] = await reports(parent);

  // The child's interim reply ("Waiting on my child") isn't reported; its summary is.
  expect(report).toMatchObject({ child: child.id, reply: "Child summary" });
  expect(report?.evidence).toContain("- Tool calls: 1");

  const children = await (
    await SELF.fetch(`https://worker/api/sessions/${child.id}/children`, { headers })
  ).json<{ children: { id: string }[] }>();

  const grandchild = children.children[0]?.id ?? "";
  expect(await reports(child.id)).toMatchObject([
    { child: grandchild, reply: "Grandchild result" },
  ]);
  await idle(parent, child.id);
  expect(await reports(parent)).toHaveLength(1);
}, 15000);

it.each(["child", "root"])(
  "recursively aborts children and queued messages from %s, without reporting",
  async (target) => {
    // Finish provider initialization before introducing intentionally blocked requests.
    let block = false;
    let aborted = 0;
    let started = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if (!block) return answer();
      started++;

      return blocked(init, () => aborted++);
    });
    const parent = await root();
    const child = await spawn(parent);
    await idle(parent, child.id);
    await expect.poll(async () => (await reports(parent)).length).toBe(1);
    // The parent answers its report before anything blocks.
    await expect
      .poll(
        async () =>
          (
            await (await SELF.fetch(`https://worker/api/sessions/${parent}`, { headers })).text()
          ).split('"kind":"pi.assistant"').length - 1,
      )
      .toBe(1);
    block = true;
    const grandchild = await spawn(child.id);
    await expect.poll(() => started).toBe(1);

    const sent = await post(`${parent}/children/${child.id}/messages`, {
      content: "Blocked",
      requestId: crypto.randomUUID(),
    });

    expect(sent.status).toBe(202);
    await expect.poll(() => started).toBe(2);
    expect((await status(parent, child.id)).state).toBe("working");

    expect((await post(`${target === "child" ? child.id : parent}/abort`, {})).status).toBe(200);
    expect(aborted).toBe(2);
    await expect.poll(async () => (await status(parent, child.id)).state).toBe("stopped");
    expect((await status(child.id, grandchild.id)).state).toBe("stopped");
    expect(started).toBe(2);
    expect(await reports(parent)).toHaveLength(1);
    block = false;

    const resumed = await post(`${parent}/children/${child.id}/messages`, {
      content: "New work",
      requestId: crypto.randomUUID(),
    });

    expect(resumed.status).toBe(202);
    await idle(parent, child.id);
    expect((await status(parent, child.id)).latest_reply).toBe("Child answer");
    await expect.poll(async () => (await reports(parent)).length).toBe(2);
  },
);

it("bounds unanswered messages per child and validates and redacts HTTP inputs", async () => {
  let block = false;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) =>
    block ? blocked(init) : answer(`Bearer abc ${access} test-refresh`),
  );
  const parent = await root();

  for (const body of [
    { content: "", requestId: crypto.randomUUID() },
    { content: "Hi", requestId: "bad" },
    { content: "Hi", requestId: crypto.randomUUID(), model: "unknown" },
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

  block = true;

  for (let count = 0; count < 8; count++) {
    const response = await post(`${parent}/children/${child.id}/messages`, {
      content: `Next ${count}`,
      requestId: crypto.randomUUID(),
    });

    expect(response.status).toBe(202);
  }

  const over = await post(`${parent}/children/${child.id}/messages`, {
    content: "Over budget",
    requestId: crypto.randomUUID(),
  });

  expect(over.status).toBe(409);
  expect(await over.json()).toEqual({
    error: "8 messages to this child are still unanswered. Wait for its report.",
  });
});

it.each([
  { rounds: 21, reply: "Finished after 21 tool turns" },
  // Runs are unbounded (agent.ts clears stored turn limits), so long tool loops still answer.
  { rounds: 100, reply: "Finished after 100 tool turns" },
])(
  "reports a child correctly after $rounds tool turns",
  async ({ rounds, reply }) => {
    let turns = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const request = await modelRequest(init);

      if (request.serialized.includes("[Child report")) return answer("Noted");

      if (turns === rounds) return answer(`Finished after ${rounds} tool turns`);
      turns++;

      return toolCall("task_status", { id: "missing" }, `status_${turns}`);
    });
    const parent = await root();
    const child = await spawn(parent);
    // A hundred real durable tool/generation turns need headroom under parallel CI load.
    await expect
      .poll(async () => (await status(parent, child.id)).state, { timeout: 10000 })
      .toBe("idle");
    expect(await status(parent, child.id)).toMatchObject({
      last_turn: "answered",
      latest_reply: reply,
    });
    expect(turns).toBe(rounds);
    await expect.poll(async () => (await reports(parent)).length, { timeout: 4000 }).toBe(1);
    expect((await reports(parent))[0]).toMatchObject({ reply });
    expect((await reports(parent))[0]?.evidence).toContain(`- Tool calls: ${rounds}`);
  },
  15000,
);

it("lists spawned sessions with their parent and persists keeping one in the sidebar", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
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
    title: "Investigate the flaky test",
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
