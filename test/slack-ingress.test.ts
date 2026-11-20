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

/** Fake Slack and Claude: Haiku classifies, Sonnet answers the session, Slack records posts. */
function fakeServices(classification: string) {
  const posted: Posted[] = [];
  const models: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));

    if (parsed.hostname === "slack.com") {
      const method = parsed.pathname.slice(5);
      const body = JSON.parse(String(init?.body ?? "{}"));
      posted.push({ method, body });

      if (method === "auth.test")
        return Response.json({ ok: true, team_id: "THOME", team: "Home", user_id: "UBOT" });

      if (method === "conversations.info")
        return Response.json({ ok: true, channel: { name: "eng" } });

      return Response.json({ ok: true, ts: "1.1" });
    }

    if (parsed.hostname === "api.anthropic.com") {
      const model = JSON.parse(String(init?.body)).model;
      models.push(model);

      return claudeReply(model === "claude-haiku-5-5" ? classification : "**Done** for Slack");
    }

    throw new Error(`Unexpected request to ${parsed.hostname}`);
  });

  return { posted, models };
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

  const put = (body: Record<string, string | boolean>) =>
    SELF.fetch("https://dolly.example.com/api/integrations/slack", {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  expect((await put({ enabled: true, allowedUserId: "", defaultRepository: "" })).status).toBe(409);
  expect(
    (
      await put({
        enabled: true,
        botToken,
        signingSecret,
        allowedUserId: "UOWNER",
        defaultRepository: "example/project",
      })
    ).status,
  ).toBe(200);
  expect(posted.map((call) => call.method)).toEqual(["auth.test"]);

  const status = await SELF.fetch("https://dolly.example.com/api/integrations/slack", { headers });
  const text = await status.text();
  expect(text).not.toContain(botToken);
  expect(text).not.toContain(signingSecret);

  const body = JSON.parse(text);
  expect(body).toMatchObject({
    configured: true,
    enabled: true,
    allowedUserId: "UOWNER",
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
