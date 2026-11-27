import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { mockFetch } from "./titles";
import { Live, Snapshot } from "../src/transcript";
import { SlackThreads } from "../src/slack-inbox";
import { GitHubThreads } from "../src/github-inbox";
import { AutomationRunDoc } from "../src/automations";
import { ConversationWorkspace, workspaceConfig } from "../src/workspace";

const claudeToken = `sk-ant-oat01-${"a".repeat(40)}`;
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

/**
 * Model responses in order, plus Claude's usage endpoint for live refreshes. Title requests get an
 * unusable answer, so sessions keep their first-line titles and `query` can find them by prompt.
 */
function model(responses: Array<() => Response>, title = "") {
  const usageFetches: string[] = [];

  mockFetch(async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.includes("/api/oauth/usage")) {
      usageFetches.push(url);

      return Response.json({ five_hour: { utilization: 42, resets_at: null } });
    }

    const next = responses.shift();

    if (!next) throw new Error(`Unexpected model request ${url}`);

    return next();
  }, title);

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
  await settled(id);
}

/** Wait until a session's run has ended with an answer. */
async function settled(id: string) {
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

/** Spawn a task under `parent` through the children API, as spawn_task does. */
async function spawn(parent: string, content: string, mode?: string) {
  const response = await SELF.fetch(`https://worker/api/sessions/${parent}/children`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: crypto.randomUUID(), ...(mode && { mode }) }),
  });

  expect(response.status).toBe(202);

  return (await response.json<{ id: string }>()).id;
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
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
    // ChatGPT reports no limits to connected apps; Claude's stand in for a provider that does.
    await state.storage.put("credential:anthropic", { type: "api_key", key: claudeToken });
    await state.storage.put("usage:anthropic", {
      providerId: "anthropic",
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
  await run(id, "How much Claude do I have left?");
  const [stored, refreshed, cooled] = await dollyResults(id);

  expect(stored).toMatchObject({
    ok: true,
    providers: [
      { provider: "openai", connected: true, limits: [] },
      {
        provider: "anthropic",
        connected: true,
        source: "headers",
        limits: [{ name: "5h", usedPercent: 30, remainingPercent: 70 }],
      },
    ],
  });
  expect(refreshed).toMatchObject({
    ok: true,
    providers: [
      { provider: "openai", connected: true, limits: [] },
      { provider: "anthropic", source: "live", limits: [{ name: "5h", usedPercent: 42 }] },
    ],
  });
  expect(refreshed).not.toHaveProperty("refreshSkipped");
  expect(cooled).toMatchObject({ ok: true, refreshSkipped: expect.stringContaining("5 minutes") });
  expect(usageFetches).toHaveLength(1);
  expect(JSON.stringify([stored, refreshed, cooled])).not.toContain(access);
  expect(JSON.stringify([stored, refreshed, cooled])).not.toContain(claudeToken);
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

it("lists the owner's work by default and titles reviews by pull request", async () => {
  model([
    () => answer("Shipped"),
    () => answer("Child answered"),
    () => answer("Child answered"),
    () => call({ action: "list_sessions" }),
    () => call({ action: "list_sessions", kind: "review" }),
    () => call({ action: "list_sessions", kind: "all" }),
    () => answer("Done"),
  ]);

  const created = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ workspace: { repository: "octocat/project", ref: "main" } }),
  });

  const work = (await created.json<{ id: string }>()).id;
  await run(work, "Ship the onboarding flow");
  const review = await session();
  const nightly = await session();

  // As github-inbox.ts admits an automatic review and automations.ts starts a run.
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const reviewId = (await state.storage.get<ConversationId>(`session:${review}`))!;
    const nightlyId = (await state.storage.get<ConversationId>(`session:${nightly}`))!;

    await agent["harness"].commit(async (tx) => {
      (await tx.doc(ConversationWorkspace, reviewId)).config = workspaceConfig(
        { repository: "octo/app", ref: "refs/pull/12/head" },
        String(reviewId),
        { readOnly: true },
      );
      (await tx.doc(GitHubThreads)).threads["review:octo/app#12@abcdef1234567"] = {
        id: reviewId,
        events: {},
      };
      (await tx.doc(AutomationRunDoc, nightlyId)).run = {
        automationId: "nightly",
        name: "Nightly dependency check",
        trigger: "schedule",
        mcpServers: [],
      };
    }, BACKGROUND_CONTEXT);
  });

  // A read-only ask task is still the owner's work; an automation's worker inherits its run.
  const asked = await spawn(work, "Check the migration", "ask");
  const worker = await spawn(nightly, "Bump the lockfile");
  await settled(asked);
  await settled(worker);

  const reader = await session();
  await run(reader, "Who is working on what?");
  const [listed, reviews, everything] = await dollyResults(reader);

  // The reader itself is work too, and is listed while it runs.
  expect(listed).toMatchObject({ ok: true, kind: "work", hidden: { review: 1, automation: 2 } });
  expect(listed).toMatchObject({
    sessions: expect.arrayContaining([
      expect.objectContaining({ id: work, kind: "work", title: "Ship the onboarding flow" }),
      expect.objectContaining({ id: asked, kind: "work", parentId: work }),
    ]),
  });

  // Compare whole ids: a spawned session's short numeric id can occur inside another's UUID.
  for (const id of [review, nightly, worker])
    expect(listed).toMatchObject({
      sessions: expect.not.arrayContaining([expect.objectContaining({ id })]),
    });

  expect(reviews).toMatchObject({
    ok: true,
    kind: "review",
    total: 1,
    sessions: [{ id: review, kind: "review", title: "Review octo/app#12 at abcdef1" }],
  });

  expect(everything).toMatchObject({ ok: true, kind: "all" });
  // Earlier tests' sessions are listed too, so check the four this one made.
  expect(everything).toMatchObject({
    sessions: expect.arrayContaining(
      [work, review, nightly, reader, asked, worker].map((id) => expect.objectContaining({ id })),
    ),
  });
  expect(everything).not.toHaveProperty("hidden");
  expect(everything).toMatchObject({
    sessions: expect.arrayContaining([
      expect.objectContaining({
        id: nightly,
        kind: "automation",
        automation: "Nightly dependency check",
      }),
      expect.objectContaining({ id: worker, kind: "automation", parentId: nightly }),
    ]),
  });
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

/** A model response calling any one of the session's tools. */
const callTool = (name: string, args: Record<string, string | number | boolean>) =>
  sse({
    type: "function_call",
    id: `fc_${crypto.randomUUID()}`,
    call_id: `call_${crypto.randomUUID()}`,
    name,
    arguments: JSON.stringify(args),
  });

/** A session's saved status, once the run that just ended has recorded it. */
async function statusOf(id: string) {
  let status: { text: string; waitingOn: string; at: number } | undefined;

  await expect
    .poll(
      async () => {
        const listed = await SELF.fetch("https://worker/api/sessions", { headers });
        const sessions = await listed.json<{ id: string; status?: typeof status }[]>();
        status = sessions.find((session) => session.id === id)?.status;

        return status !== undefined;
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  return status!;
}

it("lists where each session's latest run left it, redacted, and what it waits on", async () => {
  model([
    () =>
      answer(
        `Migrated the billing tables with token ${access}. Next I would backfill the invoices, once you say so.`,
      ),
    () => callTool("schedule_prompt", { prompt: "Check the backfill finished", in_minutes: 60 }),
    () => answer("Scheduled a check on the backfill in an hour.\nNothing else to do until then."),
    () => call({ action: "list_sessions" }),
    () => answer("Done"),
  ]);

  const idle = await session();
  await run(idle, "Migrate the billing tables");
  const scheduled = await session();
  await run(scheduled, "Check on the backfill later");

  // Saved when each run ends, outside the run itself.
  expect(await statusOf(idle)).toMatchObject({
    text: "Migrated the billing tables with token [redacted].",
    waitingOn: "owner",
  });
  expect(await statusOf(scheduled)).toMatchObject({
    text: "Scheduled a check on the backfill in an hour.",
    waitingOn: "schedule",
  });

  const reader = await session();
  await run(reader, "Who is waiting on me?");
  const [listed] = await dollyResults(reader);

  expect(listed).toMatchObject({
    ok: true,
    sessions: expect.arrayContaining([
      expect.objectContaining({
        id: idle,
        running: false,
        status: {
          text: "Migrated the billing tables with token [redacted].",
          waitingOn: "owner",
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      }),
      expect.objectContaining({
        id: scheduled,
        status: expect.objectContaining({ waitingOn: "schedule" }),
      }),
    ]),
    notes: expect.arrayContaining([expect.stringContaining("waitingOn")]),
  });
  expect(JSON.stringify(listed)).not.toContain(access.slice(0, 20));
});
