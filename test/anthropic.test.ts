import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { Snapshot, Live } from "../src/transcript";

const token = `sk-ant-oat01-${"a".repeat(64)}`;

function reply(text = "OK") {
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
    { headers: { "content-type": "text/event-stream", "request-id": "req_claude_test" } },
  );
}

const call = <A>(path: string, method = "GET", body?: A) =>
  SELF.fetch(`https://worker/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(async () => {
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("credential:anthropic");
    await state.storage.delete("credential:openai-codex");
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("protects Claude credentials, rejects API keys, and stores a wrapped setup token without making requests", async () => {
  expect((await SELF.fetch("https://worker/api/auth/anthropic")).status).toBe(401);
  expect((await call("/auth/anthropic", "PUT", { token: "sk-ant-api03-billed-key" })).status).toBe(
    400,
  );
  expect((await call("/auth/anthropic", "PUT", { token: "bad" })).status).toBe(400);

  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Saving must not contact Anthropic"));

  const saved = await call("/auth/anthropic", "PUT", {
    token: ` ${token.slice(0, 30)}\n${token.slice(30)} `,
  });

  expect(await saved.json()).toEqual({ connected: true, experimental: true });
  expect(fetch).not.toHaveBeenCalled();
  await abortAllDurableObjects();
  expect(await (await call("/auth/anthropic")).json()).toEqual({
    connected: true,
    experimental: true,
  });
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    expect(await state.storage.get("credential:anthropic")).toEqual({
      type: "api_key",
      key: token,
    });
  });
  expect((await call("/auth/anthropic/test", "POST", { model: "not-a-model" })).status).toBe(400);
  expect((await call("/auth/anthropic/test", "POST", { model: "gpt-6-sol" })).status).toBe(400);
});

it("runs an explicit bounded live inference probe through the Worker Anthropic adapter", async () => {
  await call("/auth/anthropic", "PUT", { token });

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    expect(target.hostname).toBe("api.anthropic.com");
    expect(target.pathname).toBe("/v1/messages");
    expect(init?.redirect).toBe("manual");
    const sent = new Headers(init?.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${token}`);
    expect(sent.has("x-api-key")).toBe(false);
    expect(sent.get("anthropic-beta")).toContain("oauth-2025-04-20");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.max_tokens).toBe(32);

    return reply();
  });

  const response = await call("/auth/anthropic/test", "POST", {});
  expect(await response.json()).toMatchObject({
    ok: true,
    model: "claude-haiku-5-5",
    upstream: {
      status: 200,
      contentType: "text/event-stream",
      requestId: "req_claude_test",
      rayId: null,
    },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reports upstream HTML blocks without returning raw HTML, leaking tokens, retrying or refreshing", async () => {
  await call("/auth/anthropic", "PUT", { token });

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(`<html>Unable to load site ${token}</html>`, {
        status: 403,
        headers: { "content-type": "text/html", "cf-ray": "test-ray" },
      }),
  );

  const response = await call("/auth/anthropic/test", "POST", {});
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    ok: false,
    upstream: { status: 403, contentType: "text/html", rayId: "test-ray" },
  });
  expect(text).toContain("upstream edge block");
  expect(text).not.toContain("<html>");
  expect(text).not.toContain(token);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await (await call("/auth/anthropic")).json()).toMatchObject({ connected: true });
});

it("distinguishes JSON authentication errors from HTML edge blocks without leaking credentials", async () => {
  await call("/auth/anthropic", "PUT", { token });

  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      Response.json(
        { error: { type: "authentication_error", message: `Invalid setup token ${token}` } },
        { status: 401, headers: { "request-id": token } },
      ),
    );

  const response = await call("/auth/anthropic/test", "POST", {});
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    ok: false,
    upstream: { status: 401, contentType: "application/json" },
  });
  expect(text).toContain("Invalid setup token");
  expect(text).not.toContain("upstream edge block");
  expect(text).not.toContain(token);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("runs Claude-only conversations without Codex credentials and keeps existing model selection explicit", async () => {
  expect((await call("/sessions", "POST", { model: "claude-haiku-5-5" })).status).toBe(409);
  await call("/auth/anthropic", "PUT", { token });

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toContain("api.anthropic.com/v1/messages");

    return reply("Hello from Claude");
  });

  const response = await call("/sessions", "POST", { model: "claude-haiku-5-5" });
  expect(response.status).toBe(201);
  const session = await response.json<{ id: string; model: string }>();
  expect(session.model).toBe("claude-haiku-5-5");
  expect((await call("/sessions", "POST", { model: "gpt-6-sol" })).status).toBe(409);
  const defaultSession = await call("/sessions", "POST", {});
  expect(await defaultSession.json()).toMatchObject({ model: "claude-sonnet-5-5" });
  expect(
    (
      await call(`/sessions/${session.id}/messages`, "POST", {
        content: "hi",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);

  const read = async () =>
    Schema.decodeUnknownSync(Snapshot)(await (await call(`/sessions/${session.id}`)).json());

  await expect
    .poll(async () => JSON.stringify(await read()), { timeout: 4000 })
    .toContain("Hello from Claude");
  expect(Schema.decodeUnknownSync(Live)((await read()).docs["pi.live"]).runFailure).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  await abortAllDurableObjects();
  expect(JSON.stringify(await read())).toContain("Hello from Claude");
  await call("/auth/anthropic", "DELETE");
  expect(await (await call("/auth/anthropic")).json()).toMatchObject({ connected: false });
  expect(
    (
      await call(`/sessions/${session.id}/messages`, "POST", {
        content: "again",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});

it("inherits Claude for child agents and redacts setup tokens from transcript and child answers", async () => {
  await call("/auth/anthropic", "PUT", { token });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toContain("api.anthropic.com/v1/messages");

    return reply(`Claude child answered without exposing ${token}`);
  });

  const parent = await (
    await call("/sessions", "POST", { model: "claude-haiku-5-5" })
  ).json<{ id: string }>();

  const response = await call(`/sessions/${parent.id}/children`, "POST", {
    content: "Say hello",
    requestId: crypto.randomUUID(),
  });

  expect(response.status).toBe(202);
  const child = await response.json<{ id: string; model: string; taskId: string }>();
  expect(child.model).toBe("claude-haiku-5-5");
  await expect
    .poll(async () => (await call(`/sessions/${child.id}`)).text(), { timeout: 4000 })
    .toContain("Claude child answered");
  expect(await (await call(`/sessions/${child.id}`)).text()).not.toContain(token);

  const stream = await SELF.fetch(`https://worker/api/sessions/${child.id}/events`, {
    headers: { ...headers, Upgrade: "websocket", Origin: "https://worker" },
  });

  expect(stream.status).toBe(101);
  const socket = stream.webSocket;

  if (!socket) throw new Error("Expected a session WebSocket");
  const updates: string[] = [];
  socket.addEventListener("message", (event) => {
    updates.push(String(event.data));
  });
  socket.accept();

  try {
    await expect.poll(() => updates.length).toBeGreaterThan(0);
    expect(updates[0]).toContain("Claude child answered");
    expect(updates[0]).not.toContain(token);
  } finally {
    socket.close();
  }

  await expect
    .poll(async () => (await call(`/sessions/${parent.id}/tasks/${child.taskId}`)).text(), {
      timeout: 4000,
    })
    .toContain("Claude child answered");
  expect(await (await call(`/sessions/${parent.id}/tasks/${child.taskId}`)).text()).not.toContain(
    token,
  );
  expect(
    (
      await call(`/sessions/${parent.id}/children`, "POST", {
        content: "Use Codex",
        model: "gpt-6-sol",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});

it("executes Dolly tools through Anthropic and resumes generation with their results", async () => {
  await call("/auth/anthropic", "PUT", { token });
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (requests++ > 0) return reply("No repositories enrolled.");
    const tools = JSON.parse(String(init?.body)).tools;
    expect(
      tools.find((tool: { name: string }) => tool.name === "workspace").input_schema,
    ).toMatchObject({
      type: "object",
      required: ["action"],
      properties: { action: { enum: expect.arrayContaining(["checkout", "attach"]) } },
    });

    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_tool",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_workspace", name: "workspace", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ action: "repositories" }),
        },
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
  });

  const session = await (
    await call("/sessions", "POST", { model: "claude-haiku-5-5" })
  ).json<{ id: string }>();

  await call(`/sessions/${session.id}/messages`, "POST", {
    content: "List workspace repositories",
    requestId: crypto.randomUUID(),
  });
  await expect
    .poll(async () => (await call(`/sessions/${session.id}`)).text(), { timeout: 4000 })
    .toContain("No repositories enrolled.");
  expect(requests).toBe(2);
  expect(await (await call(`/sessions/${session.id}`)).text()).toContain("toolResult");
});

it("includes the selected repository in Claude's system prompt before any tool call", async () => {
  await call("/auth/anthropic", "PUT", { token });
  let system = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toContain("api.anthropic.com/v1/messages");
    system = JSON.stringify(JSON.parse(String(init?.body)).system);

    return reply("I know which repository this session selected.");
  });

  const session = await (
    await call("/sessions", "POST", {
      model: "claude-haiku-5-5",
      workspace: { repository: "rozenmd/dolly", ref: "main" },
    })
  ).json<{ id: string }>();

  await call(`/sessions/${session.id}/messages`, "POST", {
    content: "Work on dolly",
    requestId: crypto.randomUUID(),
  });
  await expect.poll(() => system, { timeout: 4000 }).toContain("rozenmd/dolly");
  expect(system).toContain("workspace-context");
  expect(system).toContain("workspace checkout");
  expect(system).toContain("not proof of GitHub access");
  expect(system).not.toContain(token);
});
