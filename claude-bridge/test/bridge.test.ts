/**
 * The bridge end to end: real Claude Code (the Agent SDK's bundled CLI) behind the bridge's HTTP
 * server, against a scripted stand-in for Anthropic's API. No real inference is made.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { JsonObject, MessagesRequest } from "../src/messages.ts";
import { PLACEHOLDER_TOKEN, startServer } from "../src/server.ts";

/** The port a server listening on port 0 was given. */
function port(server: Server) {
  return z.object({ port: z.number() }).parse(server.address()).port;
}

type Upstream = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: UpstreamBody;
};

type UpstreamBody = {
  model: string;
  system: Array<{ text: string }>;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  tools?: Array<{ name: string; input_schema: { properties?: JsonObject } }>;
};

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, string | number> };

type Reply = { content: Block[]; stop: "end_turn" | "tool_use" };

const requests: Upstream[] = [];
let replies: Reply[] = [];

/** Hold the next upstream response open until the client goes away. */
let holdNext = false;
let heldResolve: () => void = () => undefined;
let closedResolve: () => void = () => undefined;
let held = new Promise<void>((resolve) => (heldResolve = resolve));
let upstreamClosed = new Promise<void>((resolve) => (closedResolve = resolve));

/** One upstream response as the stream events Anthropic sends. */
function stream(reply: Reply, model: string) {
  const events: Array<[string, JsonObject]> = [
    [
      "message_start",
      {
        message: {
          id: `msg_${requests.length}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      },
    ],
  ];

  reply.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        ["content_block_start", { index, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }],
      );
    } else {
      events.push(
        ["content_block_start", { index, content_block: { ...block, input: {} } }],
        [
          "content_block_delta",
          { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
        ],
      );
    }

    events.push(["content_block_stop", { index }]);
  });
  events.push(
    [
      "message_delta",
      { delta: { stop_reason: reply.stop, stop_sequence: null }, usage: { output_tokens: 7 } },
    ],
    ["message_stop", {}],
  );

  return events
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join("");
}

let anthropic: Server;
let bridge: Server;
let bridgeUrl: string;
const key = "test-bridge-key";

before(async () => {
  anthropic = createServer(async (incoming, outgoing) => {
    let text = "";

    for await (const chunk of incoming) text += chunk;

    if (incoming.method !== "POST" || !incoming.url?.startsWith("/v1/messages?")) {
      outgoing.writeHead(404, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ type: "error", error: { type: "not_found_error" } }));

      return;
    }

    const body: UpstreamBody = JSON.parse(text);
    requests.push({ path: incoming.url, headers: incoming.headers, body });

    if (holdNext) {
      holdNext = false;
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.flushHeaders();
      outgoing.on("close", () => closedResolve());
      heldResolve();

      return;
    }

    const reply = replies.shift() ?? {
      content: [{ type: "text", text: "Done." }],
      stop: "end_turn",
    };

    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(stream(reply, body.model));
  });
  await new Promise<void>((resolve) => anthropic.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "claude-bridge-"));

  bridge = startServer(0, {
    PATH: process.env.PATH,
    HOME: home,
    DOLLY_BRIDGE_KEY: key,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port(anthropic)}`,
  });
  await new Promise<void>((resolve) => bridge.once("listening", resolve));
  bridgeUrl = `http://127.0.0.1:${port(bridge)}`;
});

after(() => {
  bridge.close();
  anthropic.close();
});

beforeEach(() => {
  requests.length = 0;
  replies = [];
});

const shellTool = {
  name: "shell",
  description: "Run a shell command",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "integer", minimum: 1, maximum: 3600, description: "Seconds" },
      mode: {
        anyOf: [
          { type: "object", properties: { kind: { const: "fast" } }, required: ["kind"] },
          { type: "object", properties: { kind: { const: "slow" }, retries: { type: "integer" } } },
        ],
      },
    },
    required: ["command"],
  },
};

/** Enough tools that Claude Code would otherwise defer some behind tool search. */
const extraTools = Array.from({ length: 30 }, (_, index) => ({
  name: `tool_${index}`,
  description: `Tool number ${index}`,
  input_schema: { type: "object", properties: { value: { type: "string" } } },
}));

type Event = { event: string; data: JsonObject & { type: string } };

async function send(
  body: z.input<typeof MessagesRequest>,
  session = "conversation-1",
  headers = {},
) {
  return fetch(`${bridgeUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dolly-bridge-key": key,
      "x-dolly-session": session,
      "x-dolly-context-window": "200000",
      ...headers,
    },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 4096, stream: true, ...body }),
  });
}

async function events(response: Response) {
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const parsed: Event[] = [];

  for (const frame of (await response.text()).split("\n\n")) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];

    if (event && data) parsed.push({ event, data: JSON.parse(data) });
  }

  return parsed;
}

test("answers through real Claude Code with its subscription identity and the client's prompt", async () => {
  replies.push({ content: [{ type: "text", text: "Hello from Claude Code" }], stop: "end_turn" });

  const response = await send({
    system: [{ type: "text", text: "You are Dolly, a coding agent." }],
    messages: [{ role: "user", content: "Say hello" }],
    tools: [shellTool, ...extraTools],
  });

  const stream = await events(response);
  assert.deepEqual(
    stream.map((event) => event.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.deepEqual(stream[2]?.data.delta, { type: "text_delta", text: "Hello from Claude Code" });
  assert.deepEqual(stream[4]?.data.delta, { stop_reason: "end_turn", stop_sequence: null });

  assert.equal(requests.length, 1);
  const [upstream] = requests;
  assert.ok(upstream);
  // Claude Code itself talks to Anthropic, with its own identity and only the placeholder token.
  assert.equal(upstream.headers.authorization, `Bearer ${PLACEHOLDER_TOKEN}`);
  assert.equal(upstream.headers["x-app"], "cli");
  assert.match(String(upstream.headers["user-agent"]), /^claude-cli\/\d/);
  assert.match(String(upstream.headers["anthropic-beta"]), /claude-code-20250219/);
  assert.match(String(upstream.headers["anthropic-beta"]), /oauth-2025-04-20/);
  assert.equal(upstream.body.model, "claude-sonnet-5-5");
  assert.ok(upstream.body.system.some((block) => block.text.includes("You are Dolly")));
  assert.ok(JSON.stringify(upstream.body.messages).includes("Say hello"));

  // Only the client's tools exist, all sent up front, with schemas intact (unions included).
  assert.deepEqual(
    upstream.body.tools?.map((tool) => tool.name).sort(),
    ["shell", ...extraTools.map((tool) => tool.name)].map((name) => `mcp__dolly__${name}`).sort(),
  );
  const schema = upstream.body.tools?.[0]?.input_schema;
  assert.ok(schema?.properties?.command);
  assert.match(JSON.stringify(schema?.properties?.mode), /anyOf/);
  assert.match(JSON.stringify(schema?.properties?.timeout), /"maximum":3600/);
});

test("hands tool calls to the client and resumes the SDK session with their results", async () => {
  replies.push(
    {
      content: [
        { type: "text", text: "Listing files." },
        { type: "tool_use", id: "toolu_1", name: "mcp__dolly__shell", input: { command: "ls" } },
      ],
      stop: "tool_use",
    },
    // Claude Code's second turn after the blocked call.
    { content: [{ type: "text", text: "Waiting for the result." }], stop: "end_turn" },
  );

  const first = await events(
    await send(
      {
        system: "You are Dolly.",
        messages: [{ role: "user", content: "What files are here?" }],
        tools: [shellTool],
      },
      "conversation-tools",
    ),
  );

  const started = first.filter((event) => event.event === "content_block_start");
  assert.deepEqual(
    started.map((event) => event.data.content_block),
    [
      { type: "text", text: "" },
      { type: "text", text: "" },
      { type: "tool_use", id: "toolu_1", name: "shell", input: {} },
    ],
  );

  const toolInput = first.find(
    (event) =>
      event.event === "content_block_delta" &&
      JSON.stringify(event.data.delta).includes("input_json_delta"),
  );

  assert.deepEqual(toolInput?.data.delta, {
    type: "input_json_delta",
    partial_json: JSON.stringify({ command: "ls" }),
  });
  assert.deepEqual(first.find((event) => event.event === "message_delta")?.data.delta, {
    stop_reason: "tool_use",
    stop_sequence: null,
  });
  assert.equal(requests.length, 2);

  // The client ran the tool; its result goes back on the same session.
  replies.push({
    content: [{ type: "text", text: "There is one file: README.md" }],
    stop: "end_turn",
  });

  const second = await events(
    await send(
      {
        system: "You are Dolly.",
        messages: [
          { role: "user", content: "What files are here?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Listing files." },
              { type: "tool_use", id: "toolu_1", name: "shell", input: { command: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "README.md" }],
              },
            ],
          },
        ],
        tools: [shellTool],
      },
      "conversation-tools",
    ),
  );

  assert.match(JSON.stringify(second), /There is one file: README\.md/);
  assert.equal(requests.length, 3);
  const resumed = JSON.stringify(requests[2]?.body.messages);
  // Resumed, not replayed: the earlier exchange is Claude Code's own record of it, and the new
  // turn carries only the tool output.
  assert.match(resumed, /What files are here\?/);
  assert.match(resumed, /README\.md/);
  assert.doesNotMatch(resumed, /\[Your previous reply\]/);
});

test("replays the whole conversation when the history no longer matches the SDK session", async () => {
  replies.push({ content: [{ type: "text", text: "Fresh answer" }], stop: "end_turn" });

  const response = await events(
    await send(
      {
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
          { role: "user", content: "New question" },
        ],
      },
      "conversation-new",
    ),
  );

  assert.match(JSON.stringify(response), /Fresh answer/);
  const replayed = JSON.stringify(requests[0]?.body.messages);
  assert.match(replayed, /Earlier question/);
  assert.match(replayed, /\[Your previous reply\]\\nEarlier answer/);
  assert.match(replayed, /New question/);
});

test("reports a Claude Code usage-limit notice as an error, not as the model's answer", async () => {
  replies.push({
    content: [{ type: "text", text: "You've hit your session limit · resets 3am (UTC)" }],
    stop: "end_turn",
  });

  const stream = await events(
    await send({ messages: [{ role: "user", content: "hi" }] }, "conversation-limit"),
  );

  assert.deepEqual(
    stream.map((event) => event.event),
    ["error"],
  );
  assert.match(JSON.stringify(stream[0]?.data.error), /You've hit your session limit/);
});

test("answers non-streaming requests with one Anthropic message", async () => {
  replies.push({ content: [{ type: "text", text: "Plain JSON" }], stop: "end_turn" });

  const response = await send(
    { stream: false, messages: [{ role: "user", content: "hi" }] },
    "conversation-json",
  );

  assert.equal(response.status, 200);
  const message = await response.json();
  assert.equal(message.type, "message");
  assert.equal(message.stop_reason, "end_turn");
  assert.deepEqual(message.content, [{ type: "text", text: "Plain JSON" }]);
  assert.equal(message.usage.input_tokens, 11);
});

test("refuses callers without the bridge key and malformed requests, before starting Claude Code", async () => {
  const unauthorized = await send(
    { messages: [{ role: "user", content: "hi" }] },
    "conversation-key",
    { "x-dolly-bridge-key": "wrong" },
  );

  assert.equal(unauthorized.status, 401);

  const malformed = await send({ messages: [] }, "conversation-key");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.type, "invalid_request_error");

  const missing = await fetch(`${bridgeUrl}/v1/other`, { method: "POST" });
  assert.equal(missing.status, 404);

  assert.equal((await fetch(`${bridgeUrl}/health`)).status, 200);
  assert.equal(requests.length, 0);
});

test("stops Claude Code's upstream request when the client goes away", async () => {
  holdNext = true;
  const controller = new AbortController();

  const response = await fetch(`${bridgeUrl}/v1/messages`, {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json", "x-dolly-bridge-key": key },
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      stream: true,
      messages: [{ role: "user", content: "slow" }],
    }),
  });

  assert.equal(response.status, 200);
  await held;
  controller.abort();
  await assert.rejects(response.text());
  // Claude Code's own request to Anthropic is closed with it.
  await upstreamClosed;
});
