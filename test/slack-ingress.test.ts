import * as Schema from "effect/Schema";
import { Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { env } from "cloudflare:workers";
import {
  SELF,
  abortAllDurableObjects,
  createExecutionContext,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ingress } from "../src/ingress";
import { SlackIngress } from "../src/slack-ingress";
import { SlackThreads } from "../src/slack-inbox";
import type { SlackSetup } from "../src/slack";
import { ASK_MODE_NOTE, SLACK_SESSION_NOTE } from "../src/slack-intent";
import { ConversationWorkspace } from "../src/workspace";
import { headers, signIn } from "./session";

const signingSecret = "0123456789abcdef0123456789abcdef";
const botToken = "xoxb-1111-2222-abcdefghijkl";
const claudeToken = `sk-ant-oat01-${"a".repeat(64)}`;
const slackEntry = new SlackIngress(createExecutionContext(), env);
const githubEntry = { fetch: async () => new Response(null, { status: 404 }) };

const profile = {
  enabled: true,
  botToken,
  signingSecret,
  // Saved before teammates were a list: read as one member without a GitHub login.
  allowedUserId: "UOWNER",
  defaultRepository: "example/project",
  teamId: "THOME",
  teamName: "Home",
  botUserId: "UBOT",
};

async function sign(body: string, timestamp: number, secret = signingSecret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );

  return `v0=${Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function post<A>(
  path: string,
  value: A,
  options: { timestamp?: number; secret?: string; raw?: string } = {},
) {
  const body = options.raw ?? JSON.stringify(value);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

  return ingress.request(
    `https://ingress${path}`,
    {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": String(timestamp),
        "X-Slack-Signature": await sign(body, timestamp, options.secret),
      },
      body,
    },
    { INGRESS: githubEntry, SLACK: slackEntry },
  );
}

const dm = (ts: string, text: string, extra: Record<string, string> = {}) => ({
  type: "event_callback",
  team_id: "THOME",
  event_id: `Ev${ts.replace(".", "")}`,
  event: {
    type: "message",
    channel_type: "im",
    channel: "D0DM",
    user: "UOWNER",
    team: "THOME",
    text,
    ts,
    ...extra,
  },
});

const mention = (ts: string, text: string) => ({
  type: "event_callback",
  team_id: "THOME",
  event: { type: "app_mention", channel: "C0CHAN", user: "UOWNER", team: "THOME", text, ts },
});

function claudeReply(text: string) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_claude",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type Posted = { method: string; body: Record<string, string> };

/** Slack display names for users.info. */
const names = new Map([
  ["UOWNER", "Ada Owner"],
  ["UPARTNER", "Pat Partner"],
]);

/** Fake Slack and Claude: Haiku classifies, Sonnet answers the session, Slack records posts. */
function fakeServices(classification: string) {
  const posted: Posted[] = [];
  const models: string[] = [];
  const requests: { model: string; messages: unknown[] }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));

    if (parsed.hostname === "slack.com") {
      const method = parsed.pathname.slice(5);
      const body = JSON.parse(String(init?.body ?? "{}"));

      // Name lookups are reads, kept out of the recorded posts.
      if (method === "users.info")
        return names.has(body.user)
          ? Response.json({ ok: true, user: { profile: { display_name: names.get(body.user) } } })
          : Response.json({ ok: false, error: "user_not_found" });

      posted.push({ method, body });

      if (method === "auth.test")
        return Response.json({ ok: true, team_id: "THOME", team: "Home", user_id: "UBOT" });

      if (method === "conversations.info")
        return Response.json({ ok: true, channel: { name: "eng" } });

      return Response.json({ ok: true, ts: "1.1" });
    }

    if (parsed.hostname === "api.anthropic.com") {
      const request = JSON.parse(String(init?.body));
      const model = request.model;
      models.push(model);
      requests.push(request);

      return claudeReply(model === "claude-haiku-5-5" ? classification : "**Done** for Slack");
    }

    throw new Error(`Unexpected request to ${parsed.hostname}`);
  });

  return { posted, models, requests };
}

const open = Harness.open;
let harnesses: Harness[] = [];

beforeEach(async () => {
  harnesses = [];
  vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
    const harness = await open(...args);
    harnesses.push(harness);

    return harness;
  });
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("slack:profile", profile);
    await state.storage.put("slack:public-base-url", "https://dolly.example.com");
    await state.storage.put("github:accounts", ["example"]);
    await state.storage.put("github:repositories", [
      { fullName: "example/project", defaultBranch: "main", private: false, description: null },
    ]);
    await state.storage.put("credential:anthropic", { type: "api_key", key: claudeToken });
    await state.storage.delete("credential:openai");
    await state.storage.delete("settings:default-model");
  });
});

afterEach(async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async () => {
    await harnesses.at(-1)?.close(BACKGROUND_CONTEXT);
  });
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

async function threads() {
  return runInDurableObject(env.AGENT.getByName("owner"), async () => {
    const harness = harnesses.at(-1);

    if (!harness) throw new Error("Expected live harness");
    const state = await harness.snapshot(SlackThreads, BACKGROUND_CONTEXT);

    return Object.fromEntries(
      await Promise.all(
        Object.entries(state?.threads ?? {}).map(async ([key, thread]) => [
          key,
          {
            events: Object.keys(thread.events),
            creator: thread.creator,
            workspace: (
              await harness.snapshot(ConversationWorkspace, thread.id, BACKGROUND_CONTEXT)
            )?.config,
          },
        ]),
      ),
    );
  });
}

it("exposes only the signed Slack routes and fails closed", async () => {
  const bindings = { INGRESS: githubEntry, SLACK: slackEntry };

  for (const [path, method] of [
    ["/slack/events", "GET"],
    ["/slack/other", "POST"],
  ])
    expect((await ingress.request(`https://ingress${path}`, { method }, bindings)).status).toBe(
      404,
    );

  expect((await SELF.fetch("https://worker/slack/events", { method: "POST" })).status).toBe(404);
  expect((await post("/slack/events", dm("1.1", "hi"), { secret: "f".repeat(32) })).status).toBe(
    401,
  );
  expect(
    (await post("/slack/events", dm("1.1", "hi"), { timestamp: Date.now() / 1000 - 301 })).status,
  ).toBe(401);
  expect((await post("/slack/actions", {}, { raw: "payload=%7B%7D" })).status).toBe(200);
  expect(
    (
      await ingress.request(
        "https://ingress/slack/events",
        { method: "POST", body: "x".repeat(1_048_577) },
        bindings,
      )
    ).status,
  ).toBe(413);

  const challenge = await post("/slack/events", { type: "url_verification", challenge: "abc" });
  expect(await challenge.json()).toEqual({ challenge: "abc" });

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("slack:profile");
  });
  expect((await post("/slack/events", dm("1.1", "hi"))).status).toBe(401);
});

it("saves Slack settings through auth.test and never returns the credentials", async () => {
  const { posted } = fakeServices("{}");
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("slack:profile");
    await state.storage.put("github:ingress", "https://hooks.example.com/hooks/github");
  });

  const put = (path: string, body: SlackSetup | { members: unknown[] }) =>
    SELF.fetch(`https://dolly.example.com/api/integrations/slack${path}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const members = (list: unknown[]) => put("/members", { members: list });

  expect((await put("", { enabled: true, defaultRepository: "" })).status).toBe(409);
  // Teammates need a connected Slack app.
  expect((await members([{ slackId: "UOWNER", github: "octocat" }])).status).toBe(409);
  expect(
    (
      await put("", {
        enabled: true,
        botToken,
        signingSecret,
        defaultRepository: "example/project",
      })
    ).status,
  ).toBe(200);
  // Member IDs and GitHub logins are validated.
  expect((await members([{ slackId: "not an id", github: "octocat" }])).status).toBe(400);
  expect((await members([{ slackId: "UOWNER", github: "not a login!" }])).status).toBe(400);

  const saved = await members([
    { slackId: "UOLD", github: "octocat" },
    { slackId: "UPARTNER", github: "hubot" },
    // A later entry for the same person replaces the earlier one.
    { slackId: "UOWNER", github: "OctoCat" },
  ]);

  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    members: [
      { slackId: "UOWNER", github: "OctoCat" },
      { slackId: "UPARTNER", github: "hubot" },
    ],
  });
  // Reconnecting keeps the teammates.
  expect(
    (await put("", { enabled: true, botToken, signingSecret, defaultRepository: "" })).status,
  ).toBe(200);
  expect(posted.map((call) => call.method)).toEqual(["auth.test", "auth.test"]);

  const status = await SELF.fetch("https://dolly.example.com/api/integrations/slack", { headers });
  const text = await status.text();
  expect(text).not.toContain(botToken);
  expect(text).not.toContain(signingSecret);

  const body = JSON.parse(text);
  expect(body).toMatchObject({
    configured: true,
    enabled: true,
    members: [
      { slackId: "UOWNER", github: "OctoCat" },
      { slackId: "UPARTNER", github: "hubot" },
    ],
    teamName: "Home",
    eventsUrl: "https://hooks.example.com/slack/events",
    actionsUrl: "https://hooks.example.com/slack/actions",
  });

  const manifest = JSON.parse(
    decodeURIComponent(new URL(body.createAppUrl).searchParams.get("manifest_json") ?? ""),
  );

  expect(manifest.settings.event_subscriptions.request_url).toBe(
    "https://hooks.example.com/slack/events",
  );
  expect(manifest.features.unfurl_domains).toEqual(["dolly.example.com"]);
  expect(manifest.oauth_config.scopes.bot).toContain("assistant:write");
  expect(JSON.parse(body.manifest)).toEqual(manifest);
});

it("turns a DM into a session, replies in its thread, and gates who may start and steer sessions", async () => {
  const { posted, models } = fakeServices("{}");

  expect((await post("/slack/events", dm("100.1", "<@UBOT> what is **this**?"))).status).toBe(200);
  // Slack retries deliver the same message again; it is admitted once.
  expect((await post("/slack/events", dm("100.1", "<@UBOT> what is **this**?"))).status).toBe(200);

  await expect
    .poll(() => posted.filter((call) => call.method === "chat.postMessage"), { timeout: 15_000 })
    .toHaveLength(2);

  const admittedId = await runInDurableObject(env.AGENT.getByName("owner"), async () => {
    const state = await harnesses.at(-1)!.snapshot(SlackThreads, BACKGROUND_CONTEXT);

    return String(state?.threads["D0DM:100.1"]?.id);
  });

  // :eyes: first, then the session link, then :eyes: comes off before the answer.
  expect(
    posted
      .filter((call) => call.method !== "auth.test")
      .map((call) => [call.method, call.body.name ?? call.body.text]),
  ).toEqual([
    ["reactions.add", "eyes"],
    [
      "chat.postMessage",
      `Created and started working on <https://dolly.example.com/session/${admittedId}|this session>`,
    ],
    ["reactions.remove", "eyes"],
    ["chat.postMessage", "*Done* for Slack"],
  ]);
  expect(posted.find((call) => call.method === "reactions.add")?.body).toMatchObject({
    channel: "D0DM",
    timestamp: "100.1",
  });
  const reply = posted.filter((call) => call.method === "chat.postMessage").at(-1);
  expect(reply?.body).toMatchObject({
    channel: "D0DM",
    thread_ts: "100.1",
    text: "*Done* for Slack",
  });
  // DMs do not run the mention classifier.
  expect(models).toEqual(["claude-sonnet-5-5"]);

  const admitted = await threads();
  expect(Object.keys(admitted)).toEqual(["D0DM:100.1"]);
  expect(admitted["D0DM:100.1"].events).toEqual(["100.1"]);
  expect(admitted["D0DM:100.1"].workspace?.repository).toBe("example/project");

  // A stranger cannot start a session, Slack Connect partners are ignored, but anyone in the
  // workspace may reply in a thread already linked to a session.
  expect((await post("/slack/events", dm("101.1", "hi", { user: "USTRANGER" }))).status).toBe(200);
  expect(
    (await post("/slack/events", dm("102.1", "hi", { thread_ts: "100.1", team: "TOTHER" }))).status,
  ).toBe(200);
  expect(
    (await post("/slack/events", dm("103.1", "more", { thread_ts: "100.1", user: "UTEAM" })))
      .status,
  ).toBe(200);
  // Bot messages never start work.
  expect((await post("/slack/events", dm("104.1", "echo", { bot_id: "B1" }))).status).toBe(200);

  const after = await threads();
  expect(Object.keys(after)).toEqual(["D0DM:100.1"]);
  expect(after["D0DM:100.1"].events).toEqual(["100.1", "103.1"]);
  // A follow-up gets no new session link; its :eyes: stays until it is answered.
  await expect
    .poll(
      () =>
        posted
          .slice(-3)
          .map((call) => [call.method, call.body.timestamp ?? call.body.thread_ts, call.body.name]),
      { timeout: 15_000 },
    )
    .toEqual([
      ["reactions.add", "103.1", "eyes"],
      ["chat.postMessage", "100.1", undefined],
      ["reactions.remove", "103.1", "eyes"],
    ]);
}, 30_000);

it("lets only listed teammates start sessions and names who asked", async () => {
  const { posted, requests } = fakeServices("{}");
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const { allowedUserId: _legacy, ...rest } = profile;
    await state.storage.put("slack:profile", {
      ...rest,
      members: [
        { slackId: "UOWNER", github: "octocat" },
        { slackId: "UPARTNER", github: null },
      ],
    });
  });

  const answered = (count: number) =>
    expect
      .poll(() => posted.filter((call) => call.method === "chat.postMessage"), { timeout: 15_000 })
      .toHaveLength(count);

  expect((await post("/slack/events", dm("400.1", "<@UBOT> hello"))).status).toBe(200);
  await answered(2);
  expect(JSON.stringify(requests.at(-1))).toContain(
    "Sent by Ada Owner (<@UOWNER>, GitHub @octocat) in a Slack DM.",
  );

  // A listed teammate without a login is named by their Slack name alone.
  expect((await post("/slack/events", dm("401.1", "hi", { user: "UPARTNER" }))).status).toBe(200);
  await answered(4);
  expect(JSON.stringify(requests.at(-1))).toContain(
    "Sent by Pat Partner (<@UPARTNER>) in a Slack DM.",
  );

  // Nobody else can start a session, and being listed does not admit a Slack Connect partner.
  expect((await post("/slack/events", dm("402.1", "hi", { user: "USTRANGER" }))).status).toBe(200);
  expect(
    (await post("/slack/events", dm("403.1", "hi", { user: "UPARTNER", team: "TOTHER" }))).status,
  ).toBe(200);

  const started = Object.keys(await threads());
  expect(started).toEqual(expect.arrayContaining(["D0DM:400.1", "D0DM:401.1"]));
  expect(started).not.toContain("D0DM:402.1");
  expect(started).not.toContain("D0DM:403.1");
}, 30_000);

it("starts Slack sessions with the owner's saved default model", async () => {
  const { posted, models } = fakeServices("{}");

  const saved = await SELF.fetch("https://worker/api/settings/model", {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "claude-opus-5-5" }),
  });

  expect(saved.status).toBe(200);
  expect((await post("/slack/events", dm("150.1", "<@UBOT> hello"))).status).toBe(200);
  await expect
    .poll(() => posted.filter((call) => call.method === "chat.postMessage"), { timeout: 15_000 })
    .toHaveLength(2);
  expect(models).toEqual(["claude-opus-5-5"]);
}, 30_000);

it("classifies a mention with Claude Haiku and starts the PR pass on the PR head", async () => {
  const { posted, models } = fakeServices('{"action":"review","prNumber":5,"mode":"code"}');

  expect((await post("/slack/events", mention("200.1", "<@UBOT> review PR 5"))).status).toBe(200);
  await expect
    .poll(() => posted.filter((call) => call.method === "chat.postMessage"), { timeout: 15_000 })
    .toHaveLength(2);
  expect(models[0]).toBe("claude-haiku-5-5");
  expect(models).toContain("claude-sonnet-5-5");

  const admitted = await threads();
  expect(admitted["C0CHAN:200.1"].workspace).toMatchObject({
    repository: "example/project",
    ref: "refs/pull/5/head",
  });
  expect(posted.filter((call) => call.method === "chat.postMessage").at(-1)?.body.thread_ts).toBe(
    "200.1",
  );
}, 30_000);

it("falls back to a code task in the default repository when Claude is not connected", async () => {
  const { posted, models } = fakeServices("{}");
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("credential:anthropic");
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
  const fetch = vi.mocked(globalThis.fetch);
  const slack = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, init) => {
    if (new URL(String(url)).hostname !== "api.openai.com") return slack!(url, init);

    const item = {
      type: "message",
      id: "msg_slack",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Codex answer", annotations: [] }],
    };

    const events = [
      { type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "r",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];

    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });

  expect((await post("/slack/events", mention("300.1", "<@UBOT> fix the bug"))).status).toBe(200);
  await expect
    .poll(() => posted.filter((call) => call.method === "chat.postMessage"), { timeout: 15_000 })
    .toHaveLength(2);
  expect(models).toEqual([]);
  expect((await threads())["C0CHAN:300.1"].workspace).toMatchObject({
    repository: "example/project",
    ref: "HEAD",
  });
  expect(posted.filter((call) => call.method === "chat.postMessage").at(-1)?.body.text).toBe(
    "Codex answer",
  );
}, 30_000);

it("leads the session prompt with the request, then the mode and Slack notes", async () => {
  const { posted, requests } = fakeServices(
    '{"action":"none","prNumber":null,"mode":"ask","repo":null}',
  );

  expect(
    (await post("/slack/events", mention("400.1", "<@UBOT> how does &lt;Foo&gt; work?"))).status,
  ).toBe(200);
  await expect
    .poll(() => posted.filter((call) => call.method === "chat.postMessage"), { timeout: 15_000 })
    .toHaveLength(2);

  const session = requests.find((request) => request.model === "claude-sonnet-5-5");
  const first = JSON.stringify(session?.messages[0]);

  // No header or brackets: the person's words first, then plain-paragraph notes.
  expect(first).toContain(
    JSON.stringify(`how does <Foo> work?\n\n${ASK_MODE_NOTE}\n\n${SLACK_SESSION_NOTE}`).slice(
      1,
      -1,
    ),
  );
  expect(first).not.toContain("Slack mention from");
}, 30_000);

/** A Claude reply that calls one tool. */
function claudeToolUse(name: string, input: Record<string, string>, id = "toolu_mcp") {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A minimal MCP server that lists one `ping` tool and answers calls to it. */
async function mcpServer(name: string, request: Request) {
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
}

it("gives a Slack thread open MCP servers, and restricted ones only when its starter is listed", async () => {
  const { posted, requests } = fakeServices("{}");
  const base = vi.mocked(fetch).getMockImplementation()!;
  const calls: string[] = [];
  let sessionTurns = 0;

  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));
    const name = parsed.hostname.match(/^mcp\.(\w+)\.example$/)?.[1];

    if (name) {
      const request = new Request(url, init);

      if (request.method === "POST")
        calls.push(`${name}:${(await request.clone().json<{ method: string }>()).method}`);

      return mcpServer(name, request);
    }

    if (parsed.hostname === "api.anthropic.com" && !String(init?.body).includes("claude-haiku")) {
      sessionTurns += 1;

      // Each thread pings the open server, then the restricted one, then answers.
      const program = ["return await tools.linear.ping({})", "return await tools.secret.ping({})"][
        (sessionTurns - 1) % 3
      ];

      if (program) {
        await base(url, init);

        return claudeToolUse("mcp", { code: program }, `toolu_${sessionTurns}`);
      }
    }

    return base(url, init);
  });

  type ServerBody = {
    name?: string;
    url?: string;
    headers?: Record<string, string>;
    allowedUsers: readonly string[];
  };

  const api = (path: string, method: string, body: ServerBody) =>
    SELF.fetch(`https://worker/api${path}`, { method, headers, body: JSON.stringify(body) });

  for (const [name, allowedUsers] of [
    ["linear", []],
    // `github:uowner` spells the starter's Slack ID as a GitHub login: it must not match.
    ["secret", ["USOMEONE", "octocat", "github:uowner"]],
  ] as const)
    expect(
      (
        await api("/connections/mcp", "POST", {
          name,
          url: `https://mcp.${name}.example/mcp`,
          headers: { Authorization: `Bearer ${name}-key` },
          allowedUsers,
        })
      ).status,
    ).toBe(200);

  const replies = () => posted.filter((call) => call.method === "chat.postMessage");

  // UOWNER isn't listed on `secret`: the thread gets Linear only.
  expect((await post("/slack/events", dm("500.1", "<@UBOT> ping both"))).status).toBe(200);
  await expect.poll(replies, { timeout: 15_000 }).toHaveLength(2);

  let session = requests.filter((request) => request.model === "claude-sonnet-5-5");
  expect(session).toHaveLength(3);
  expect(JSON.stringify(session[0])).toContain("linear (Linear");
  expect(JSON.stringify(session[0])).not.toContain("secret (Secret");
  expect(JSON.stringify(session[1])).toContain("pong from linear");
  expect(JSON.stringify(session[2])).not.toContain("pong from secret");
  expect(calls.filter((call) => call.startsWith("secret:"))).toEqual([]);
  expect(calls).toContain("linear:tools/call");
  expect((await threads())["D0DM:500.1"]?.creator).toBe("UOWNER");

  // Listing UOWNER opens `secret` to threads UOWNER starts.
  expect(
    (await api("/connections/mcp/secret", "PUT", { allowedUsers: ["UOWNER", " @octocat "] }))
      .status,
  ).toBe(200);
  expect(
    (
      await (
        await SELF.fetch("https://worker/api/connections", { headers })
      ).json<{ mcpServers: { name: string; allowedUsers: string[] }[] }>()
    ).mcpServers.find((server) => server.name === "secret")?.allowedUsers,
  ).toEqual(["slack:UOWNER", "github:octocat"]);

  expect((await post("/slack/events", dm("600.1", "<@UBOT> ping both again"))).status).toBe(200);
  await expect.poll(replies, { timeout: 15_000 }).toHaveLength(4);

  session = requests.filter((request) => request.model === "claude-sonnet-5-5").slice(3);
  expect(JSON.stringify(session[0])).toContain("secret (Secret");
  expect(JSON.stringify(session[2])).toContain("pong from secret");
  expect(JSON.stringify(requests)).not.toContain("secret-key");
}, 30_000);

it("shows a session a Slack thread spawns only the MCP servers the thread's starter may use", async () => {
  // Names of their own: storage outlives earlier tests' servers.
  const { posted } = fakeServices("{}");
  const base = vi.mocked(fetch).getMockImplementation()!;
  const childSystems: string[] = [];
  let parentTurns = 0;

  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));

    if (parsed.hostname === "api.anthropic.com" && !String(init?.body).includes("claude-haiku")) {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ system: Schema.Unknown, messages: Schema.Array(Schema.Unknown) }),
      )(JSON.parse(String(init?.body)));

      if (JSON.stringify(body.messages[0]).includes("child ping")) {
        childSystems.push(JSON.stringify(body.system));

        return base(url, init);
      }

      parentTurns += 1;

      if (parentTurns === 1) {
        await base(url, init);

        return claudeToolUse("spawn_task", { content: "child ping" }, "toolu_spawn");
      }
    }

    return base(url, init);
  });

  const added: string[] = [];

  for (const [name, allowedUsers] of [
    ["notes", []],
    ["vault", ["USOMEONE"]],
  ] as const) {
    const response = await SELF.fetch("https://worker/api/connections/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name,
        url: `https://mcp.${name}.example/mcp`,
        headers: { Authorization: `Bearer ${name}-key` },
        allowedUsers,
      }),
    });

    added.push(`${response.status} ${await response.text()}`);
  }

  expect(added).toEqual(['200 {"ok":true}', '200 {"ok":true}']);

  expect((await post("/slack/events", dm("700.1", "<@UBOT> delegate this"))).status).toBe(200);
  await expect
    .poll(() => posted.filter((call) => call.method === "chat.postMessage"), { timeout: 15_000 })
    .toHaveLength(2);
  await expect.poll(() => childSystems.length, { timeout: 15_000 }).toBeGreaterThan(0);

  expect(childSystems[0]).toContain("notes (Notes");
  expect(childSystems[0]).not.toContain("vault (Vault");
  expect(childSystems[0]).not.toContain("mcp.vault.example");
}, 30_000);
