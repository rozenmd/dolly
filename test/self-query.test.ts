import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { Live, Snapshot } from "../src/transcript";
import { SlackThreads } from "../src/slack-inbox";

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

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

const answer = (text: string) =>
  sse({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });

const call = (args: Record<string, string | number | boolean>) =>
  sse({
    type: "function_call",
    id: `fc_${crypto.randomUUID()}`,
    call_id: `call_${crypto.randomUUID()}`,
    name: "dolly",
    arguments: JSON.stringify(args),
  });

/** Model responses in order, plus ChatGPT's usage endpoint for live refreshes. */
function model(responses: Array<() => Response>) {
  const usageFetches: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.includes("/wham/usage")) {
      usageFetches.push(url);

      return Response.json({
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18_000,
            reset_after_seconds: 600,
          },
        },
      });
    }

    const next = responses.shift();

    if (!next) throw new Error(`Unexpected model request ${url}`);

    return next();
  });

  return { usageFetches };
}

async function session() {
  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });

  return (await created.json<{ id: string }>()).id;
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot));

async function snapshot(id: string) {
  return decode(await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text());
}

/** Send a prompt and wait for the run to settle with an answer. */
async function run(id: string, content: string) {
  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);

  await expect
    .poll(
      async () => {
        const current = await snapshot(id);

        const live = Option.getOrUndefined(
          Schema.decodeUnknownOption(Live)(current.docs["pi.live"]),
        );

        return (
          live !== undefined &&
          live.run === undefined &&
          current.entries.some((entry) => entry.model?.some((m) => m.role === "assistant"))
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

const Reply = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

/** The `dolly` tool results of a session, in order. */
async function dollyResults(id: string) {
  return (await snapshot(id)).entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult" &&
      message.toolName === "dolly" &&
      Array.isArray(message.content)
        ? message.content.flatMap((block) =>
            block.text ? [Schema.decodeUnknownSync(Reply)(block.text)] : [],
          )
        : [],
    ),
  );
}

beforeEach(async () => {
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
    await state.storage.put("usage:openai-codex", {
      providerId: "openai-codex",
      windows: [{ label: "5h", usedPercent: 30, resetsAt: Date.now() + 3_600_000 }],
      observedAt: Date.now(),
      source: "headers",
    });
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("reports subscription usage and rate-limits live refreshes", async () => {
  const { usageFetches } = model([
    () => call({ action: "usage" }),
    () => call({ action: "usage", refresh: true }),
    () => call({ action: "usage", refresh: true }),
    () => answer("Usage checked"),
  ]);

  const id = await session();
  await run(id, "How much Codex do I have left?");
  const [stored, refreshed, cooled] = await dollyResults(id);

  expect(stored).toMatchObject({
    ok: true,
    providers: [
      {
        provider: "openai-codex",
        connected: true,
        source: "headers",
        limits: [{ name: "5h", usedPercent: 30, remainingPercent: 70 }],
      },
      { provider: "anthropic", connected: false, limits: [] },
    ],
  });
  expect(refreshed).toMatchObject({
    ok: true,
    providers: [
      { provider: "openai-codex", source: "live", limits: [{ name: "5h", usedPercent: 42 }] },
      { provider: "anthropic", connected: false },
    ],
  });
  expect(refreshed).not.toHaveProperty("refreshSkipped");
  expect(cooled).toMatchObject({ ok: true, refreshSkipped: expect.stringContaining("5 minutes") });
  expect(usageFetches).toHaveLength(1);
  expect(JSON.stringify([stored, refreshed, cooled])).not.toContain(access);
});

it("lists and reads other web sessions, redacting credentials", async () => {
  model([
    () => answer("Alpha migration finished"),
    () => call({ action: "list_sessions", query: "ALPHA" }),
    () => call({ action: "read_session", session: alpha, limit: 5 }),
    () => call({ action: "read_session", session: "no-such-session" }),
    () => answer("Done"),
  ]);

  const alpha = await session();
  await run(alpha, `Alpha migration, token ${access}`);
  const reader = await session();
  await run(reader, "Summarize the migration work");
  const [listed, read, missing] = await dollyResults(reader);

  expect(listed).toMatchObject({
    ok: true,
    status: "active",
    total: 1,
    sessions: [{ id: alpha, running: false, archived: false }],
  });
  // Titles are cut at 80 characters; the credential must be redacted, not truncated.
  expect(listed).toMatchObject({
    sessions: [{ title: expect.stringContaining("Alpha migration, token [redacted]") }],
  });
  expect(read).toMatchObject({
    ok: true,
    session: { id: alpha },
    messages: [
      { role: "user", text: expect.stringContaining("Alpha migration") },
      { role: "assistant", text: "Alpha migration finished" },
    ],
  });
  expect(JSON.stringify([listed, read])).not.toContain(access.slice(0, 20));
  expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("no-such-session") });
});

it("withholds session history from conversations started in a Slack thread", async () => {
  model([
    () => call({ action: "list_sessions" }),
    () => call({ action: "read_session", session: "anything" }),
    () => call({ action: "usage" }),
    () => answer("Done"),
  ]);

  const id = await session();

  // Mark this conversation as a Slack intake thread, as slack-inbox.ts does on creation.
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;
    await agent["harness"].commit(async (tx) => {
      const threads = await tx.doc(SlackThreads);
      threads.threads["C1:1.0"] = { id: conversationId, events: {} };
    }, BACKGROUND_CONTEXT);
  });

  await run(id, "List my sessions");
  const [listed, read, usage] = await dollyResults(id);

  expect(listed).toMatchObject({ ok: false, error: expect.stringContaining("Slack") });
  expect(read).toMatchObject({ ok: false, error: expect.stringContaining("Slack") });
  expect(usage).toMatchObject({ ok: true });
});

it("adds the dolly tool to existing sessions' explicit tool lists", async () => {
  const id = await session();

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;
    await agent["harness"].commit(
      (tx) => configure(tx, conversationId, { tools: [] }),
      BACKGROUND_CONTEXT,
    );
    await state.storage.delete("migration:dolly-tool");
  });
  await abortAllDurableObjects();
  await SELF.fetch(`https://worker/api/sessions/${id}`, { headers });

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;
    const conversation = (await agent["harness"].conversation(conversationId, BACKGROUND_CONTEXT))!;
    expect((await conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name)).toEqual([
      "dolly",
    ]);
    expect(await state.storage.get("migration:dolly-tool")).toBe(true);
  });
});
