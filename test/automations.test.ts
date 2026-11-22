import { env } from "cloudflare:workers";
import {
  SELF,
  reset,
  runInDurableObject,
  runDurableObjectAlarm,
  abortAllDurableObjects,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { ConversationWorkspace, READ_ONLY_TOOLS } from "../src/workspace";
import { nextRunAt } from "../src/automations";

/**
 * Automations (src/automations.ts) through the real API routes, the owner Durable Object, its
 * alarm and Pi's durable tasks. Only outbound fetch (the model) and the clock are simulated.
 */

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

type CodexItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      status: "completed";
      content: { type: "output_text"; text: string; annotations: never[] }[];
    }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string };

function sse(item: CodexItem) {
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

const answer = (text: string) =>
  sse({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });

/** A JSON request body or tool argument. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const toolCall = (name: string, args: Json) =>
  sse({
    type: "function_call",
    id: `fc_${crypto.randomUUID()}`,
    call_id: `call_${crypto.randomUUID()}`,
    name,
    arguments: JSON.stringify(args),
  });

const api = (path: string, method = "GET", body?: Json) =>
  SELF.fetch(`https://worker/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const Run = Schema.Struct({
  trigger: Schema.String,
  at: Schema.Number,
  status: Schema.String,
  sessionId: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.Number),
});

const Automation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
  runAt: Schema.optional(Schema.Number),
  enabled: Schema.Boolean,
  readOnly: Schema.Boolean,
  mcpServers: Schema.Array(Schema.String),
  nextRunAt: Schema.optional(Schema.Number),
  runs: Schema.Array(Run),
});

const decodeAutomation = Schema.decodeUnknownSync(Automation);

const decodeList = Schema.decodeUnknownSync(
  Schema.Struct({ automations: Schema.Array(Automation) }),
);

async function create(body: { [key: string]: Json }) {
  const response = await api("/automations", "POST", body);
  expect(response.status).toBe(201);

  return decodeAutomation(await response.json());
}

async function read(id: string) {
  const response = await api(`/automations/${id}`);
  expect(response.status).toBe(200);

  return decodeAutomation(await response.json());
}

const transcript = async (id: string) => (await api(`/sessions/${id}`)).text();

const realNow = Date.now.bind(Date);

/** Set the shared isolate's clock to `at` and fire the Agent's alarm. */
async function alarmAt(at: number) {
  vi.spyOn(Date, "now").mockImplementation(() => at);
  await runDurableObjectAlarm(env.AGENT.getByName("owner"));
}

/** A model response that never arrives, but ends when its request is aborted. */
const hang = (request: Request) =>
  new Promise<Response>((_, reject) =>
    request.signal.addEventListener("abort", () => reject(request.signal.reason)),
  );

/** The model: every request is recorded and answered by `reply`. */
function model(reply: (body: string, request: Request) => Response | Promise<Response>) {
  const requests: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin !== "https://chatgpt.com" && url.origin !== "https://api.openai.com")
      throw new Error(`Unexpected request ${request.method} ${url.href}`);
    const body = await request.text();
    requests.push(body);

    return reply(body, request);
  });

  return requests;
}

const sessionIds: string[] = [];

/** Sign in and connect ChatGPT, valid for a month from the (possibly simulated) clock. */
async function connect() {
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 30 * 86_400_000,
    });
  });
}

beforeEach(async () => {
  await reset();
  sessionIds.length = 0;
  await connect();

  // reset() clears key-value storage but not Pi's documents, where automations live.
  for (const { id } of decodeList(await (await api("/automations")).json()).automations)
    await api(`/automations/${id}`, "DELETE");
});

afterEach(async () => {
  vi.restoreAllMocks();

  for (const id of sessionIds) await api(`/sessions/${id}/abort`, "POST", {});
  await abortAllDurableObjects();
});

it("fires a scheduled automation once, in its time zone, into a fresh titled session", async () => {
  const requests = model(() => answer("Found 2 stale pull requests"));

  // 09:00 in Paris is 07:00 UTC in summer.
  const start = Date.UTC(2031, 6, 1, 6, 0);
  vi.spyOn(Date, "now").mockImplementation(() => start);
  // Signed in at the simulated time, so the browser session and ChatGPT login outlive it.
  await connect();

  const created = await create({
    name: "Stale PR monitor",
    prompt: "List stale pull requests",
    schedule: "0 9 * * *",
    timeZone: "Europe/Paris",
  });

  expect(created.nextRunAt).toBe(Date.UTC(2031, 6, 1, 7, 0));
  expect(created.runs).toEqual([]);

  // Early alarms fire nothing.
  await alarmAt(Date.UTC(2031, 6, 1, 6, 59));
  expect((await read(created.id)).runs).toEqual([]);

  await alarmAt(Date.UTC(2031, 6, 1, 7, 0, 30));
  await expect.poll(async () => (await read(created.id)).runs[0]?.status).toBe("succeeded");

  const after = await read(created.id);
  const [run] = after.runs;
  sessionIds.push(run.sessionId!);
  expect(run).toMatchObject({ trigger: "schedule", summary: "Found 2 stale pull requests" });
  expect(after.nextRunAt).toBe(Date.UTC(2031, 6, 2, 7, 0));

  // The run is an ordinary session: its prompt says what it is, and it is named after the automation.
  const text = await transcript(run.sessionId!);
  expect(text).toContain("List stale pull requests");
  expect(text).toContain(
    '[Automation \\"Stale PR monitor\\", scheduled run at 2031-07-01T07:00:30.000Z]',
  );
  expect(text).toContain("Found 2 stale pull requests");
  expect(requests).toHaveLength(1);

  const sessions = await (
    await api("/sessions")
  ).json<{ id: string; title: string; automationRun?: { id: string; name: string } }[]>();

  expect(sessions.filter((session) => session.automationRun?.id === created.id)).toEqual([
    expect.objectContaining({
      id: run.sessionId,
      title: "Stale PR monitor",
      automationRun: { id: created.id, name: "Stale PR monitor" },
    }),
  ]);

  // The same alarm again, also after eviction, starts nothing more.
  await abortAllDurableObjects();
  await alarmAt(Date.UTC(2031, 6, 1, 7, 1));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await read(created.id)).runs).toHaveLength(1);
  expect(requests).toHaveLength(1);
});

it("runs by hand, returns the same run for a retried request and never overlaps a live run", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));

  model(async () => {
    await held;

    return answer("Done by hand");
  });

  const { id } = await create({ name: "Nightly", prompt: "Tidy up", schedule: "0 3 * * *" });
  const requestId = crypto.randomUUID();
  const first = await api(`/automations/${id}/run`, "POST", { requestId });
  expect(first.status).toBe(202);
  const started = await first.json<{ sessionId: string; duplicate: boolean }>();
  sessionIds.push(started.sessionId);
  expect(started.duplicate).toBe(false);

  const retried = await api(`/automations/${id}/run`, "POST", { requestId });
  expect(await retried.json()).toEqual({ sessionId: started.sessionId, duplicate: true });

  const overlapping = await api(`/automations/${id}/run`, "POST", {
    requestId: crypto.randomUUID(),
  });

  expect(overlapping.status).toBe(409);
  expect(await overlapping.json()).toEqual({
    error: "This automation is already running",
    sessionId: started.sessionId,
  });

  // A scheduled fire while it runs is recorded as skipped, and the schedule moves on.
  const due = (await read(id)).nextRunAt!;
  await alarmAt(due + 1_000);
  const skipped = await read(id);
  expect(skipped.runs.map((run) => run.status)).toEqual(["skipped", "running"]);
  expect(skipped.nextRunAt).toBe(due + 86_400_000);

  release();
  await expect.poll(async () => (await read(id)).runs[1]?.status).toBe("succeeded");
  expect((await read(id)).runs[1]).toMatchObject({ trigger: "manual", summary: "Done by hand" });
});

it("fires a one-off run once, and never fires a disabled automation", async () => {
  const requests = model(() => answer("Reminder delivered"));
  const start = realNow();
  vi.spyOn(Date, "now").mockImplementation(() => start);
  const at = new Date(start + 30 * 60_000).toISOString();

  const once = await create({ name: "Reminder", prompt: "Check the deploy", runAt: at });
  const off = await create({ name: "Off", prompt: "Never", schedule: "0 * * * *", enabled: false });
  expect(once.nextRunAt).toBe(Date.parse(at));
  expect(off.nextRunAt).toBeUndefined();

  await alarmAt(start + 2 * 3_600_000);
  await expect.poll(async () => (await read(once.id)).runs[0]?.status).toBe("succeeded");
  sessionIds.push((await read(once.id)).runs[0]!.sessionId!);
  expect((await read(once.id)).nextRunAt).toBeUndefined();
  expect((await read(off.id)).runs).toEqual([]);

  await alarmAt(start + 20 * 3_600_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await read(once.id)).runs).toHaveLength(1);
  expect(requests).toHaveLength(1);

  // Enabling it schedules its next fire from now.
  const enabled = await api(`/automations/${off.id}`, "PUT", { enabled: true });
  expect(await enabled.json()).toMatchObject({ enabled: true, nextRunAt: expect.any(Number) });
});

it("rejects invalid definitions with a reason", async () => {
  const cases: [{ [key: string]: Json }, string][] = [
    [{ schedule: "61 * * * *" }, 'Invalid minute "61"'],
    [{ schedule: "* * * *" }, "five fields"],
    [{ schedule: "*/5 * * * *" }, "at most every 10 minutes"],
    [{ schedule: "0 9 * * *", timeZone: "Mars/Olympus" }, 'Unknown time zone "Mars/Olympus"'],
    [{ schedule: "0 9 31 2 *" }, "never fires"],
    [{ runAt: "2031-01-01T09:00:00" }, "ISO 8601 time with an offset"],
    [{ runAt: new Date(realNow() - 60_000).toISOString() }, "at least 1 minute ahead"],
    [{ schedule: "0 9 * * *", runAt: new Date(realNow() + 3_600_000).toISOString() }, "not both"],
    [{ readOnly: true }, "needs a repository"],
    [
      { readOnly: true, workspace: { repository: "example/project" }, mcpServers: ["linear"] },
      "cannot use MCP",
    ],
  ];

  for (const [fields, error] of cases) {
    const response = await api("/automations", "POST", { name: "Bad", prompt: "x", ...fields });
    expect(response.status, JSON.stringify(fields)).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain(error);
  }

  expect((await api("/automations", "POST", { prompt: "no name" })).status).toBe(400);
  expect((await api("/automations")).status).toBe(200);

  const { automations } = await (
    await api("/automations")
  ).json<{
    automations: { name: string }[];
  }>();

  expect(automations.filter((automation) => automation.name === "Bad")).toEqual([]);
  expect((await api("/automations/missing", "PUT", { enabled: false })).status).toBe(404);
  expect(
    (await api("/automations/missing/run", "POST", { requestId: crypto.randomUUID() })).status,
  ).toBe(404);
});

it("updates, clears fields with null and deletes without touching earlier runs' sessions", async () => {
  model(() => answer("ok"));
  const { id } = await create({ name: "Weekly", prompt: "Report", schedule: "0 16 * * 1" });

  const updated = await api(`/automations/${id}`, "PUT", {
    name: "Weekly report",
    schedule: null,
    model: "gpt-6-luna",
  });

  expect(await updated.json()).toMatchObject({ name: "Weekly report", model: "gpt-6-luna" });
  const cleared = await read(id);
  expect(cleared.schedule).toBeUndefined();
  expect(cleared.nextRunAt).toBeUndefined();

  const run = await api(`/automations/${id}/run`, "POST", { requestId: crypto.randomUUID() });
  const { sessionId } = await run.json<{ sessionId: string }>();
  sessionIds.push(sessionId);
  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("succeeded");

  expect((await api(`/automations/${id}`, "DELETE")).status).toBe(200);
  expect((await api(`/automations/${id}`)).status).toBe(404);
  expect((await api(`/sessions/${sessionId}`)).status).toBe(200);
});

it("records a run that cannot start, and one whose model fails", async () => {
  let fail = true;

  model(() =>
    fail
      ? new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 400 })
      : answer("never"),
  );

  const start = realNow();
  vi.spyOn(Date, "now").mockImplementation(() => start);
  const { id } = await create({ name: "Hourly", prompt: "Check", schedule: "0 * * * *" });

  const run = await api(`/automations/${id}/run`, "POST", { requestId: crypto.randomUUID() });
  sessionIds.push((await run.json<{ sessionId: string }>()).sessionId);
  await expect
    .poll(async () => (await read(id)).runs[0]?.status, { timeout: 10_000 })
    .toBe("failed");
  expect((await read(id)).runs[0]?.error).toBeTruthy();
  fail = false;

  // Without a subscription nothing starts, but the schedule still moves on.
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("credential:openai");
  });

  const due = (await read(id)).nextRunAt!;
  await alarmAt(due + 1_000);
  const after = await read(id);
  expect(after.runs[0]).toMatchObject({ trigger: "schedule", status: "failed" });
  expect(after.runs[0]?.error).toContain("Connect ChatGPT");
  expect(after.nextRunAt).toBe(due + 3_600_000);
});

it("starts read-only runs on the read-only tool allowlist in a read-only checkout", async () => {
  model(() => answer("Read it"));

  const { id } = await create({
    name: "Audit",
    prompt: "Read the code",
    readOnly: true,
    workspace: { repository: "example/project" },
  });

  const run = await api(`/automations/${id}/run`, "POST", { requestId: crypto.randomUUID() });
  const { sessionId } = await run.json<{ sessionId: string }>();
  sessionIds.push(sessionId);

  // SAFETY: a run's sessionId is its Pi conversation ID, written by automations.ts view().
  const conversationId = Number(sessionId) as ConversationId;

  const state = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) =>
    agent["harness"].commit(
      async (tx) =>
        // Copies: the documents are only readable inside this transaction.
        Schema.decodeUnknownSync(
          Schema.fromJsonString(
            Schema.Struct({
              tools: Schema.Array(Schema.String),
              workspace: Schema.Struct({ repository: Schema.String, readOnly: Schema.Boolean }),
            }),
          ),
        )(
          JSON.stringify({
            tools: (await tx.doc(AgentDoc, conversationId)).tools,
            workspace: (await tx.doc(ConversationWorkspace, conversationId)).config,
          }),
        ),
      BACKGROUND_CONTEXT,
    ),
  );

  expect(state.tools).toEqual([...READ_ONLY_TOOLS]);
  expect(state.workspace).toMatchObject({ repository: "example/project", readOnly: true });

  // Read-only like an automatic review, but an automation run: it stays in the sidebar.
  const listed = await (
    await api("/sessions")
  ).json<{ id: string; automation?: string; automationRun?: { id: string } }[]>();

  expect(listed.find((session) => session.id === sessionId)).toMatchObject({
    automationRun: { id },
  });
  expect(listed.find((session) => session.id === sessionId)?.automation).toBeUndefined();
});

/** A minimal MCP server that lists one tool and answers calls to it. */
function mcpServer(name: string) {
  return async (request: Request) => {
    if (request.method !== "POST") return new Response(null, { status: 204 });
    const message = await request.json<{ id?: number; method: string }>();

    if (message.id === undefined) return new Response(null, { status: 202 });

    let result;

    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name, version: "1" },
      };
    else if (message.method === "tools/list")
      result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
    else result = { content: [{ type: "text", text: `pong from ${name}` }] };

    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
}

it("lets a run use only the MCP servers its automation lists, and none by default", async () => {
  const servers = new Map([
    ["https://linear.example", mcpServer("linear")],
    ["https://notion.example", mcpServer("notion")],
  ]);

  const prompts: string[] = [];
  const replies: (() => Response)[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const server = servers.get(url.origin);

    if (server) return server(request);

    if (url.origin === "https://chatgpt.com" || url.origin === "https://api.openai.com") {
      prompts.push(await request.text());
      const next = replies.shift();

      if (!next) throw new Error("Unexpected model request");

      return next();
    }

    throw new Error(`Unexpected request ${request.method} ${url.href}`);
  });

  for (const name of ["linear", "notion"])
    expect(
      (
        await api("/connections/mcp", "POST", {
          name,
          url: `https://${name}.example/mcp`,
          headers: { Authorization: "Bearer test" },
        })
      ).status,
    ).toBe(200);

  const program = (server: string) =>
    toolCall("mcp", { code: `return await tools.${server}.ping({})` });

  const scoped = await create({ name: "Scoped", prompt: "Ping", mcpServers: ["linear"] });
  const none = await create({ name: "None", prompt: "Ping" });

  replies.push(
    () => program("linear"),
    () => program("notion"),
    () => answer("Pinged"),
  );

  const first = await api(`/automations/${scoped.id}/run`, "POST", {
    requestId: crypto.randomUUID(),
  });

  sessionIds.push((await first.json<{ sessionId: string }>()).sessionId);
  await expect.poll(async () => (await read(scoped.id)).runs[0]?.status).toBe("succeeded");

  // The prompt names only the listed server; only it answers.
  expect(prompts[0]).toContain("linear (Linear");
  expect(prompts[0]).not.toContain("notion (");
  expect(prompts[1]).toContain("pong from linear");
  expect(prompts[2]).not.toContain("pong from notion");

  replies.push(
    () => program("linear"),
    () => answer("Refused"),
  );

  const second = await api(`/automations/${none.id}/run`, "POST", {
    requestId: crypto.randomUUID(),
  });

  sessionIds.push((await second.json<{ sessionId: string }>()).sessionId);
  await expect.poll(async () => (await read(none.id)).runs[0]?.status).toBe("succeeded");
  expect(prompts.at(-2)).toContain("MCP servers are not available in this session");
  expect(prompts.at(-1)).toContain(
    "automation runs may use only the servers their automation lists",
  );
  expect(prompts.at(-1)).not.toContain("pong from linear");
}, 30_000);

it("reads schedules in their time zone across daylight-saving changes and weekday rules", async () => {
  model(() => answer("ok"));

  const next = async (schedule: string, timeZone: string, from: number) => {
    vi.spyOn(Date, "now").mockImplementation(() => from);
    await connect();

    return (await create({ name: schedule, prompt: "x", schedule, timeZone })).nextRunAt;
  };

  // 02:30 does not exist in Paris on 30 March 2031 (clocks jump 02:00 → 03:00): skip to the 31st.
  expect(await next("30 2 * * *", "Europe/Paris", Date.UTC(2031, 2, 29, 12))).toBe(
    Date.UTC(2031, 2, 31, 0, 30),
  );

  // 01:30 happens twice in New York on 2 November 2031: it fires once, at the first (EDT).
  expect(await next("30 1 * * *", "America/New_York", Date.UTC(2031, 10, 2, 4))).toBe(
    Date.UTC(2031, 10, 2, 5, 30),
  );

  // Weekdays only, at 09:00 Sydney time: from a Saturday that is Monday.
  expect(await next("0 9 * * mon-fri", "Australia/Sydney", Date.UTC(2031, 0, 3, 23))).toBe(
    Date.UTC(2031, 0, 5, 22, 0),
  );

  // Day-of-month or day-of-week: the 15th or any Friday, whichever comes first.
  expect(await next("0 12 15 * fri", "UTC", Date.UTC(2031, 0, 1))).toBe(Date.UTC(2031, 0, 3, 12));
});

it("records a run the owner stops as failed", async () => {
  model((_, request) => hang(request));

  const { id } = await create({ name: "Long", prompt: "Take forever" });
  const run = await api(`/automations/${id}/run`, "POST", { requestId: crypto.randomUUID() });
  const { sessionId } = await run.json<{ sessionId: string }>();
  sessionIds.push(sessionId);

  await expect.poll(async () => (await transcript(sessionId)).includes("Take forever")).toBe(true);
  expect((await api(`/sessions/${sessionId}/abort`, "POST", {})).status).toBe(200);

  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("failed");
  expect((await read(id)).runs[0]?.error).toBe("Stopped");
});

it("finishes a run that was in flight when the Durable Object was evicted", async () => {
  let reply = hang;
  const requests = model((_, request) => reply(request));

  const { id } = await create({ name: "Resilient", prompt: "Keep going" });
  const run = await api(`/automations/${id}/run`, "POST", { requestId: crypto.randomUUID() });
  const { sessionId } = await run.json<{ sessionId: string }>();
  sessionIds.push(sessionId);

  await expect.poll(() => requests.length).toBeGreaterThan(0);
  reply = async () => answer("Finished after restart");
  await abortAllDurableObjects();

  // Any request wakes the object; Pi resumes the turn and the run task reports back.
  await expect
    .poll(async () => (await read(id)).runs[0]?.status, { timeout: 10_000 })
    .toBe("succeeded");
  expect((await read(id)).runs[0]?.summary).toBe("Finished after restart");
  expect(await transcript(sessionId)).toContain("Finished after restart");
});

it("keeps a live run and its request through any number of later skips", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let hold = false;

  model(async () => {
    if (hold) await held;

    return answer("Done");
  });

  const { id } = await create({ name: "Frequent", prompt: "Check", schedule: "*/10 * * * *" });

  // A finished run by hand, then one that keeps running.
  const finishedRequest = crypto.randomUUID();
  const finished = await api(`/automations/${id}/run`, "POST", { requestId: finishedRequest });
  const { sessionId: finishedSession } = await finished.json<{ sessionId: string }>();
  sessionIds.push(finishedSession);
  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("succeeded");

  hold = true;
  const live = await api(`/automations/${id}/run`, "POST", { requestId: crypto.randomUUID() });
  const { sessionId: liveSession } = await live.json<{ sessionId: string }>();
  sessionIds.push(liveSession);

  // More skipped scheduled fires than the history holds.
  for (let tick = 0; tick < 25; tick++) await alarmAt((await read(id)).nextRunAt! + 1_000);

  const history = await read(id);
  expect(history.runs).toHaveLength(20);
  expect(history.runs.filter((run) => run.status === "skipped")).toHaveLength(19);
  expect(history.runs.at(-1)).toMatchObject({ status: "running", sessionId: liveSession });

  // The live run still blocks overlap, and the finished request, though out of the history,
  // still returns its own session instead of starting another.
  expect(
    (await api(`/automations/${id}/run`, "POST", { requestId: crypto.randomUUID() })).status,
  ).toBe(409);

  const replay = await api(`/automations/${id}/run`, "POST", { requestId: finishedRequest });
  expect(await replay.json()).toEqual({ sessionId: finishedSession, duplicate: true });

  release();
  await expect
    .poll(async () => (await read(id)).runs.at(-1)?.status, { timeout: 10_000 })
    .toBe("succeeded");
}, 30_000);

it("keeps the alarm of a save interrupted right after it committed", async () => {
  model(() => answer("Reminded"));
  const at = realNow() + 3_600_000;

  // As if the object restarted after the save committed but before it re-armed the alarm.
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    await state.storage.deleteAlarm();
    const automations = agent["automations"];

    automations["host"].rearm = () => Promise.reject(new Error("Restarted"));
    await expect(
      automations.create({
        name: "Reminder",
        prompt: "Remind me",
        runAt: new Date(at).toISOString(),
      }),
    ).rejects.toThrow("Restarted");
    expect(await state.storage.getAlarm()).toBeLessThanOrEqual(at);
  });
  await abortAllDurableObjects();

  const [saved] = decodeList(await (await api("/automations")).json()).automations;
  expect(saved?.nextRunAt).toBe(at);

  await alarmAt(at + 1_000);
  await expect.poll(async () => (await read(saved?.id ?? "")).runs[0]?.status).toBe("succeeded");
});

it("never fires closer than the minimum interval, even across a daylight-saving jump", () => {
  // Lord Howe Island moves its clocks forward half an hour at 02:00 on 5 October 2031, so
  // 01:55 and 02:30 local are five minutes apart.
  const automation = {
    id: "a",
    name: "Twice an hour",
    prompt: "Check",
    schedule: "30,55 * * * *",
    timeZone: "Australia/Lord_Howe",
    enabled: true,
    readOnly: false,
    mcpServers: [],
    createdAt: 0,
    updatedAt: 0,
  };

  const due = Date.UTC(2031, 9, 4, 15, 25);

  expect(nextRunAt(automation, due)).toBe(Date.UTC(2031, 9, 4, 15, 30));
  expect(nextRunAt(automation, due + 1_000, due)).toBe(Date.UTC(2031, 9, 4, 15, 55));
});

it("never fires a one-off enabled once its time has come", async () => {
  const requests = model(() => answer("Should not run"));
  const at = realNow() + 3_600_000;

  const { id } = await create({
    name: "Reminder",
    prompt: "Remind me",
    runAt: new Date(at).toISOString(),
    enabled: false,
  });

  vi.spyOn(Date, "now").mockImplementation(() => at);
  expect((await api(`/automations/${id}`, "PUT", { enabled: true })).status).toBe(200);
  expect((await read(id)).nextRunAt).toBeUndefined();

  // Nothing is left half-armed for a restart to fire later.
  await abortAllDurableObjects();
  await alarmAt(at + 10_000);
  expect((await read(id)).runs).toEqual([]);
  expect((await read(id)).nextRunAt).toBeUndefined();
  expect(requests).toHaveLength(0);
});

it("spaces the next scheduled fire from a late alarm, not from the fire's due time", async () => {
  model(() => answer("Checked"));

  const { id } = await create({ name: "Frequent", prompt: "Check", schedule: "*/10 * * * *" });
  const due = (await read(id)).nextRunAt!;

  // The alarm arrives nine minutes late; the fire at due + 10 minutes would start a minute later.
  await alarmAt(due + 9 * 60_000);
  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("succeeded");
  expect((await read(id)).nextRunAt).toBe(due + 20 * 60_000);
});

it("runs a one-off on a late alarm once, across restarts", async () => {
  model(() => answer("Reminded late"));
  const at = realNow() + 3_600_000;

  const { id } = await create({
    name: "Reminder",
    prompt: "Remind me",
    runAt: new Date(at).toISOString(),
  });

  // The object first wakes a minute after the reminder was due.
  vi.spyOn(Date, "now").mockImplementation(() => at + 60_000);
  await abortAllDurableObjects();
  expect((await read(id)).nextRunAt).toBe(at);
  await alarmAt(at + 61_000);
  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("succeeded");

  // Once it has fired, later restarts don't bring it back.
  await abortAllDurableObjects();
  await alarmAt(at + 120_000);
  expect((await read(id)).nextRunAt).toBeUndefined();
  expect((await read(id)).runs).toHaveLength(1);
});

it("schedules a one-off rescheduled minutes after its late run", async () => {
  model(() => answer("Done"));
  const at = realNow() + 3_600_000;

  const { id } = await create({
    name: "Reminder",
    prompt: "Remind me",
    runAt: new Date(at).toISOString(),
  });

  // It fires nine minutes late; a minute later it is moved two minutes ahead.
  await alarmAt(at + 9 * 60_000);
  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("succeeded");
  vi.spyOn(Date, "now").mockImplementation(() => at + 10 * 60_000);

  const again = at + 12 * 60_000;
  const response = await api(`/automations/${id}`, "PUT", { runAt: new Date(again).toISOString() });
  expect(response.status).toBe(200);
  expect((await read(id)).nextRunAt).toBe(again);

  await alarmAt(again + 1_000);
  await expect
    .poll(async () => (await read(id)).runs.map((run) => run.status))
    .toEqual(["succeeded", "succeeded"]);
});

it("doesn't revive a one-off that was disabled when it came due", async () => {
  model(() => answer("Should not run"));
  const at = realNow() + 3_600_000;

  const { id } = await create({
    name: "Reminder",
    prompt: "Remind me",
    runAt: new Date(at).toISOString(),
    enabled: false,
  });

  // Enabled ten minutes after its time: there is nothing left to fire.
  vi.spyOn(Date, "now").mockImplementation(() => at + 10 * 60_000);
  expect((await api(`/automations/${id}`, "PUT", { enabled: true })).status).toBe(200);
  expect((await read(id)).nextRunAt).toBeUndefined();

  await abortAllDurableObjects();
  await alarmAt(at + 11 * 60_000);

  const after = await read(id);
  expect(after.nextRunAt).toBeUndefined();
  expect(after.runs).toEqual([]);
  expect(await (await api(`/automations/${id}`)).text()).not.toContain("armed");
});

it("keeps an overdue one-off's fire when only its details are edited", async () => {
  model(() => answer("Reminded"));
  const at = realNow() + 3_600_000;

  const { id } = await create({
    name: "Reminder",
    prompt: "Remind me",
    runAt: new Date(at).toISOString(),
  });

  // Renamed ten seconds after its time, while the alarm is late.
  vi.spyOn(Date, "now").mockImplementation(() => at + 10_000);
  expect((await api(`/automations/${id}`, "PUT", { name: "Renamed reminder" })).status).toBe(200);
  expect((await read(id)).nextRunAt).toBe(at);

  // It survives a restart too, and runs once.
  await abortAllDurableObjects();
  expect((await read(id)).nextRunAt).toBe(at);
  await alarmAt(at + 20_000);
  await expect
    .poll(async () => (await read(id)).runs.map((run) => run.status))
    .toEqual(["succeeded"]);

  // Once it has run, a further edit doesn't schedule it again.
  expect((await api(`/automations/${id}`, "PUT", { name: "Done reminder" })).status).toBe(200);
  await abortAllDurableObjects();
  expect((await read(id)).nextRunAt).toBeUndefined();
});

it("keeps an overdue cron fire when only details are edited", async () => {
  model(() => answer("Checked"));

  const { id } = await create({ name: "Frequent", prompt: "Check", schedule: "*/10 * * * *" });
  const due = (await read(id)).nextRunAt!;

  // Renamed ten seconds after the fire was due, while its alarm is late.
  vi.spyOn(Date, "now").mockImplementation(() => due + 10_000);
  expect((await api(`/automations/${id}`, "PUT", { name: "Renamed" })).status).toBe(200);
  expect((await read(id)).nextRunAt).toBe(due);

  await alarmAt(due + 20_000);
  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("succeeded");
  // Spaced from the late start, as with any late alarm.
  expect((await read(id)).nextRunAt).toBe(due + 20 * 60_000);
});

it("doesn't re-arm a one-off that fired while an edit begun before its time was saving", async () => {
  model(() => answer("Reminded"));
  const at = realNow() + 3_600_000;

  const { id } = await create({
    name: "Reminder",
    prompt: "Remind me",
    runAt: new Date(at).toISOString(),
  });

  await alarmAt(at + 1_000);
  await expect.poll(async () => (await read(id)).runs[0]?.status).toBe("succeeded");

  // An edit whose clock was read just before the reminder was due commits after it fired.
  vi.spyOn(Date, "now").mockImplementation(() => at - 1_000);
  expect((await api(`/automations/${id}`, "PUT", { name: "Renamed" })).status).toBe(200);
  expect((await read(id)).nextRunAt).toBeUndefined();

  await alarmAt(at + 60_000);
  await abortAllDurableObjects();
  expect((await read(id)).runs).toHaveLength(1);
  expect((await read(id)).nextRunAt).toBeUndefined();
});
