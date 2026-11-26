import { env, exports as entrypoints } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { mockFetch, titleResponse } from "./titles";
import { Snapshot } from "../src/transcript";
import { ClaudeCode, CLAUDE_CODE_API_KEY, type ClaudeCodeOutbound } from "../src/claude-code";

const token = `sk-ant-oat01-${"b".repeat(64)}`;

function reply(text: string, responseHeaders: Record<string, string> = {}) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_bridge",
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
    { headers: { "content-type": "text/event-stream", ...responseHeaders } },
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
    await state.storage.delete([
      "credential:anthropic",
      "settings:claude-transport",
      "usage:anthropic",
    ]);
  });
  await abortAllDurableObjects();
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("sends Claude requests directly until the owner picks Claude Code, and remembers the choice", async () => {
  expect(await (await call("/auth/anthropic")).json()).toEqual({
    connected: false,
    transport: "direct",
  });
  expect((await call("/auth/anthropic/transport", "PUT", { transport: "relay" })).status).toBe(400);

  const chosen = await call("/auth/anthropic/transport", "PUT", { transport: "claude-code" });
  expect(await chosen.json()).toEqual({ transport: "claude-code" });

  await abortAllDurableObjects();
  expect(await (await call("/auth/anthropic")).json()).toMatchObject({ transport: "claude-code" });
});

it("runs Claude sessions through Claude Code without the setup token or the Claude Code disguise", async () => {
  await call("/auth/anthropic", "PUT", { token });
  await call("/auth/anthropic/transport", "PUT", { transport: "claude-code" });

  const direct = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Claude Code mode must not call Anthropic from the Worker"));

  const bridged: Request[] = [];
  const bodies: string[] = [];

  vi.spyOn(ClaudeCode.prototype, "fetch").mockImplementation(async (request: Request) => {
    // The session's automatic title takes the same transport; it isn't the turn under test.
    const title = await titleResponse(request);

    if (title) return title;

    bridged.push(request);
    bodies.push(await request.text());

    return reply("Hello through Claude Code");
  });

  const session = await (
    await call("/sessions", "POST", { model: "claude-sonnet-5-5" })
  ).json<{ id: string }>();

  expect(
    (
      await call(`/sessions/${session.id}/messages`, "POST", {
        content: "hi there",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);

  const read = async () =>
    JSON.stringify(
      Schema.decodeUnknownSync(Snapshot)(await (await call(`/sessions/${session.id}`)).json()),
    );

  await expect.poll(read, { timeout: 4000 }).toContain("Hello through Claude Code");
  expect(direct).not.toHaveBeenCalled();

  const [request] = bridged;

  if (!request) throw new Error("Expected a request to Claude Code");

  expect(new URL(request.url).pathname).toBe("/v1/messages");
  // No credential travels to the bridge: Claude Code's own token is swapped in on the way out.
  expect(JSON.stringify([...request.headers])).not.toContain("sk-ant-oat");
  expect(request.headers.get("x-api-key")).toBe(CLAUDE_CODE_API_KEY);
  expect(request.headers.get("x-dolly-session")).toBeTruthy();
  expect(Number(request.headers.get("x-dolly-context-window"))).toBeGreaterThan(0);

  const body = JSON.parse(bodies[0] ?? "{}");
  expect(body.model).toBe("claude-sonnet-5-5");
  expect(body.thread).toBeUndefined();
  // Sonnet's default effort rides in output_config, not in a mid-conversation system message:
  // the bridge accepts only user and assistant messages.
  expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["user"]);
  expect(body.output_config?.effort).toBeTruthy();
  expect(JSON.stringify(body.messages)).toContain("hi there");
  // Dolly's own tool names and prompt: Claude Code adds its identity itself.
  expect(body.tools.map((tool: { name: string }) => tool.name)).toContain("workspace");
  expect(JSON.stringify(body.system)).not.toContain("You are Claude Code");

  // Switching back sends the next request straight to Anthropic again.
  await call("/auth/anthropic/transport", "PUT", { transport: "direct" });
  direct.mockImplementation(async () => reply("Hello directly"));

  expect(
    (
      await call(`/sessions/${session.id}/messages`, "POST", {
        content: "and again",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);
  await expect.poll(read, { timeout: 4000 }).toContain("Hello directly");
  expect(String(direct.mock.calls[0]?.[0])).toContain("api.anthropic.com/v1/messages");
  expect(bridged).toHaveLength(1);
});

it("lets Claude Code reach only Anthropic, with the owner's token swapped in", async () => {
  const sent: Array<{ url: string; headers: Headers; body: string }> = [];

  mockFetch(async (input, init) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: await request.text() });

    return reply("upstream", {
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "anthropic-ratelimit-unified-5h-reset": "1900000000",
    });
  });

  const outbound = (url: string, init?: RequestInit) =>
    runInDurableObject(env.CLAUDE_CODE.getByName("claude-code"), async () => {
      // SAFETY: src/index.ts exports ClaudeCodeOutbound; mint its loopback in the owning DO.
      const loopback = entrypoints as Cloudflare.Exports & {
        ClaudeCodeOutbound: LoopbackForExport<typeof ClaudeCodeOutbound>;
      };

      const response = await loopback.ClaudeCodeOutbound({ props: {} }).fetch(url, init);

      return { status: response.status, text: await response.text() };
    });

  const claudeRequest = {
    method: "POST",
    headers: {
      authorization: "Bearer sk-ant-oat01-dolly-claude-code-bridge-placeholder-token",
      "x-api-key": "not-a-key",
      cookie: "session=1",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    },
    body: JSON.stringify({ model: "claude-haiku-5-5" }),
  };

  // Not connected: nothing leaves.
  expect(
    (await outbound("https://api.anthropic.com/v1/messages?beta=true", claudeRequest)).status,
  ).toBe(401);
  expect(sent).toHaveLength(0);

  await call("/auth/anthropic", "PUT", { token });
  const answered = await outbound("https://api.anthropic.com/v1/messages?beta=true", claudeRequest);
  expect(answered.status).toBe(200);
  expect(answered.text).toContain("upstream");

  expect(sent).toHaveLength(1);
  const [upstream] = sent;
  expect(upstream?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  expect(upstream?.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(upstream?.headers.get("x-api-key")).toBeNull();
  expect(upstream?.headers.get("cookie")).toBeNull();
  expect(upstream?.headers.get("anthropic-beta")).toContain("claude-code-20250219");
  expect(upstream?.body).toBe(JSON.stringify({ model: "claude-haiku-5-5" }));

  // Claude Code's limit headers still feed the usage display.
  await expect
    .poll(async () => JSON.stringify(await (await call("/usage")).json()), { timeout: 4000 })
    .toContain('"usedPercent":25');

  for (const url of [
    "https://statsig.anthropic.com/v1/initialize",
    "http://api.anthropic.com/v1/messages",
    "https://api.anthropic.com:8443/v1/messages",
    "https://example.com/",
  ])
    expect((await outbound(url)).status).toBe(403);
  expect(sent).toHaveLength(1);
});
