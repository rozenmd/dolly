/**
 * The bridge end to end: real Claude Code (the Agent SDK's bundled CLI) behind the bridge's HTTP
 * server, against a scripted stand-in for Anthropic's API. No real inference is made.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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

/** Process checks read /proc: elsewhere they are skipped, and the rest of each test still runs. */
const procfs = process.platform === "linux";
const linux = { skip: !procfs };

/** The Claude Code processes the bridge (running in this test process) has started and not ended. */
function claudeProcesses() {
  const pids: number[] = [];

  if (!procfs) return pids;

  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;

    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // After "pid (comm) ": state, then the parent's pid.
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const zombie = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");

      if (
        parent === process.pid &&
        !zombie &&
        readFileSync(`/proc/${entry}/cmdline`, "utf8").includes("claude")
      )
        pids.push(Number(entry));
    } catch {
      // The process ended while being read.
    }
  }

  return pids.sort((a, b) => a - b);
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(condition());
}

type Upstream = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: UpstreamBody;
};

type UpstreamBody = {
  model: string;
  max_tokens: number;
  system: Array<{ text: string }>;
  messages: Array<{ role: string; content: string | UpstreamBlock[] }>;
  tools?: Array<{ name: string; input_schema: { properties?: JsonObject } }>;
};

type UpstreamBlock = {
  type: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type: string; text?: string }>;
};

/** Anything that would tell the model to stop: none of it may reach the model. */
const TURN_ENDING =
  /end your turn|do not call more tools|do not add text|do not retry|hook error|hook stopped continuation|forwarded to the client/i;

/** The text of a tool_result block's content. */
function resultText(block: UpstreamBlock) {
  if (!Array.isArray(block.content)) return block.content ?? "";

  return block.content.map((inner) => inner.text ?? "").join("");
}

/** The tool_result blocks of an upstream request's last user message. */
function lastResults(body: UpstreamBody) {
  const last = body.messages.filter((message) => message.role === "user").at(-1);

  if (!last || !Array.isArray(last.content)) return [];

  return last.content.filter((block) => block.type === "tool_result");
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, string | number> };

type Reply = { content: Block[]; stop: "end_turn" | "tool_use" | "max_tokens" };

const requests: Upstream[] = [];
let replies: Reply[] = [];

/** A model whose next reply depends on the request: used before `replies` when set. */
let script: ((body: UpstreamBody) => Reply) | undefined;

/** Hold the next upstream response open until the client goes away. */
let holdNext = false;

/** Stream the start of an answer as the next upstream response, then hold it open. */
let partialNext = false;
let partialResolve: () => void = () => undefined;
let partialSent = new Promise<void>((resolve) => (partialResolve = resolve));
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

    if (partialNext) {
      partialNext = false;
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.write(
        stream(
          { content: [{ type: "text", text: "PARTIAL ANSWER" }], stop: "end_turn" },
          body.model,
        ).split("event: message_delta")[0],
      );
      partialResolve();

      return;
    }

    if (holdNext) {
      holdNext = false;
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.flushHeaders();
      outgoing.on("close", () => closedResolve());
      heldResolve();

      return;
    }

    const reply = script?.(body) ??
      replies.shift() ?? {
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
  script = undefined;
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

test("hands tool calls to the client in one model call and resumes the same process with their results", async () => {
  replies.push({
    content: [
      { type: "text", text: "Listing files." },
      { type: "tool_use", id: "toolu_1", name: "mcp__dolly__shell", input: { command: "ls" } },
      { type: "tool_use", id: "toolu_2", name: "mcp__dolly__shell", input: { command: "pwd" } },
    ],
    stop: "tool_use",
  });

  const before = claudeProcesses();

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
      { type: "tool_use", id: "toolu_1", name: "shell", input: {} },
      { type: "tool_use", id: "toolu_2", name: "shell", input: {} },
    ],
  );

  const inputs = first
    .filter(
      (event) =>
        event.event === "content_block_delta" &&
        JSON.stringify(event.data.delta).includes("input_json_delta"),
    )
    .map((event) => event.data.delta);

  assert.deepEqual(inputs, [
    { type: "input_json_delta", partial_json: JSON.stringify({ command: "ls" }) },
    { type: "input_json_delta", partial_json: JSON.stringify({ command: "pwd" }) },
  ]);
  assert.deepEqual(first.find((event) => event.event === "message_delta")?.data.delta, {
    stop_reason: "tool_use",
    stop_sequence: null,
  });
  // The turn ends at the tool calls: no second model call to narrate the block.
  assert.equal(requests.length, 1);

  const kept = claudeProcesses().filter((pid) => !before.includes(pid));

  if (procfs) assert.equal(kept.length, 1);

  // The client ran the tools; their results go to the same waiting Claude Code process.
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
              { type: "tool_use", id: "toolu_2", name: "shell", input: { command: "pwd" } },
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
              { type: "tool_result", tool_use_id: "toolu_2", content: "/repo" },
            ],
          },
        ],
        tools: [shellTool],
      },
      "conversation-tools",
    ),
  );

  assert.match(JSON.stringify(second), /There is one file: README\.md/);
  assert.equal(requests.length, 2);

  if (procfs)
    assert.deepEqual(
      claudeProcesses().filter((pid) => !before.includes(pid)),
      kept,
    );
  const resumed = JSON.stringify(requests[1]?.body.messages);
  // Continued, not replayed: the earlier exchange is Claude Code's own record of it, and the new
  // turn carries only the tool output.
  assert.match(resumed, /What files are here\?/);
  assert.match(resumed, /README\.md/);
  assert.match(resumed, /\/repo/);
  assert.doesNotMatch(resumed, /\[Your previous reply\]/);

  // Both parallel results reach the model as the tool_results of its own calls, in one message,
  // and nothing in either request tells it to stop.
  const results = lastResults(requests[1]!.body);

  assert.deepEqual(
    results.map((block) => [block.tool_use_id, resultText(block)]),
    [
      ["toolu_1", "README.md"],
      ["toolu_2", "/repo"],
    ],
  );
  assert.ok(results.every((block) => !block.is_error));

  for (const upstream of requests) assert.doesNotMatch(JSON.stringify(upstream.body), TURN_ENDING);
});

const webFetchTool = {
  name: "web_fetch",
  description: "Read a web page, from an offset",
  input_schema: {
    type: "object",
    properties: { url: { type: "string" }, offset: { type: "integer" } },
    required: ["url"],
  },
};

type ClientMessage = z.input<typeof MessagesRequest>["messages"][number];

const ClientReply = z.object({
  content: z.array(
    z.object({
      type: z.enum(["text", "tool_use"]),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.record(z.string(), z.json()).optional(),
    }),
  ),
  stop_reason: z.string(),
});

/** One client request, as Dolly's agent loop makes it: the whole conversation each time. */
async function ask(messages: ClientMessage[], session: string, tools = [webFetchTool]) {
  const response = await send(
    { stream: false, system: "You are Dolly.", messages, tools },
    session,
  );

  assert.equal(response.status, 200);

  return ClientReply.parse(await response.json());
}

/** A page read in chunks: each chunk names the offset of the next. */
function chunk(offset: number) {
  return offset >= 200_000
    ? `Chunk at ${offset}. That was the last chunk.`
    : `Chunk at ${offset}. Next offset: ${offset + 40_000}`;
}

/** A model that reads the page one chunk per call, each from the offset the last result named. */
function chunkReader(body: UpstreamBody): Reply {
  const [result] = lastResults(body);
  // A replayed round's result is text in the last user message.
  const read = result ? resultText(result) : JSON.stringify(body.messages.at(-1));

  if (/last chunk/.test(read))
    return { content: [{ type: "text", text: "I've read the whole page." }], stop: "end_turn" };

  const next = /Next offset: (\d+)/.exec(read)?.[1];
  const offset = next ? Number(next) : 0;

  return {
    content: [
      {
        type: "tool_use",
        id: `toolu_chunk_${offset}`,
        name: "mcp__dolly__web_fetch",
        input: { url: "https://docs.example/llms-full.txt", offset },
      },
    ],
    stop: "tool_use",
  };
}

test("works through many tool rounds in one turn, each call reading the result before it", async () => {
  script = chunkReader;
  const before = claudeProcesses();
  const messages: ClientMessage[] = [{ role: "user", content: "Read the whole page" }];
  const offsets: number[] = [];

  // Dolly's loop: run each tool call the reply makes and send the results back, until the model
  // answers. No user message comes in between.
  for (let round = 0; round < 20; round++) {
    const reply = await ask(messages, "conversation-loop");

    messages.push({ role: "assistant", content: reply.content });
    const calls = reply.content.filter((block) => block.type === "tool_use");

    if (calls.length === 0) {
      assert.equal(reply.stop_reason, "end_turn");
      break;
    }

    assert.equal(reply.stop_reason, "tool_use");
    messages.push({
      role: "user",
      content: calls.map((call) => {
        const offset = Number(call.input?.offset);

        offsets.push(offset);

        return { type: "tool_result", tool_use_id: call.id, content: chunk(offset) };
      }),
    });
  }

  assert.deepEqual(offsets, [0, 40_000, 80_000, 120_000, 160_000, 200_000]);
  assert.match(JSON.stringify(messages.at(-1)), /I've read the whole page/);

  // One model call per round, all in the same Claude Code process.
  assert.equal(requests.length, 7);

  if (procfs) assert.equal(claudeProcesses().filter((pid) => !before.includes(pid)).length, 1);

  requests.forEach((upstream, index) => {
    const body = JSON.stringify(upstream.body);

    // Nothing the model is sent tells it to stop or end its turn.
    assert.doesNotMatch(body, TURN_ENDING);

    if (index === 0) return;
    // Each result is the tool_result of the model's own call, with the client's output.
    const offset = offsets[index - 1]!;
    const results = lastResults(upstream.body);

    assert.deepEqual(
      results.map((block) => [block.tool_use_id, resultText(block), block.is_error ?? false]),
      [[`toolu_chunk_${offset}`, chunk(offset), false]],
    );

    // After the prompt, the user said nothing: every user message only carries tool results.
    const userText = upstream.body.messages
      .slice(1)
      .filter((message) => message.role === "user")
      .flatMap((message): UpstreamBlock[] =>
        Array.isArray(message.content)
          ? message.content
          : [{ type: "text", text: message.content }],
      )
      .filter((block) => block.type !== "tool_result");

    assert.deepEqual(userText, []);
  });
});

test("hands a round's parallel calls over together, past Claude Code's default concurrency", async () => {
  const offsets = Array.from({ length: 12 }, (_, index) => index * 40_000);

  replies.push(
    {
      content: offsets.map((offset) => ({
        type: "tool_use" as const,
        id: `toolu_parallel_${offset}`,
        name: "mcp__dolly__web_fetch",
        input: { url: "https://docs.example/llms-full.txt", offset },
      })),
      stop: "tool_use",
    },
    { content: [{ type: "text", text: "Read all twelve." }], stop: "end_turn" },
  );

  const messages: ClientMessage[] = [{ role: "user", content: "Read it all at once" }];
  const reply = await ask(messages, "conversation-parallel");
  const calls = reply.content.filter((block) => block.type === "tool_use");

  assert.deepEqual(
    calls.map((call) => call.input?.offset),
    offsets,
  );

  messages.push(
    { role: "assistant", content: reply.content },
    {
      role: "user",
      content: calls.map((call) => ({
        type: "tool_result" as const,
        tool_use_id: call.id,
        content: chunk(Number(call.input?.offset)),
      })),
    },
  );

  const answer = await ask(messages, "conversation-parallel");

  assert.deepEqual(answer.content, [{ type: "text", text: "Read all twelve." }]);
  assert.equal(requests.length, 2);
  // Every result answers its own call, all in one message (in the order the calls finished).
  assert.deepEqual(
    lastResults(requests[1]!.body)
      .map((block) => [block.tool_use_id, resultText(block)])
      .sort(),
    offsets.map((offset) => [`toolu_parallel_${offset}`, chunk(offset)]).sort(),
  );
});

test(
  "resumes a tool loop whose process was lost, replaying its rounds once as tool results",
  linux,
  async () => {
    replies.push({ content: [{ type: "text", text: "Ready to read." }], stop: "end_turn" });
    const before = claudeProcesses();
    const messages: ClientMessage[] = [{ role: "user", content: "Get ready" }];
    const first = await ask(messages, "conversation-lost-loop");

    messages.push(
      { role: "assistant", content: first.content },
      { role: "user", content: "Read it" },
    );
    script = chunkReader;

    const reply = await ask(messages, "conversation-lost-loop");

    messages.push({ role: "assistant", content: reply.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_chunk_0", content: chunk(0) }],
    });

    // The process dies while the client runs the tool.
    const [waiting] = claudeProcesses().filter((pid) => !before.includes(pid));

    assert.ok(waiting);
    process.kill(waiting, "SIGKILL");
    await waitFor(() => !claudeProcesses().includes(waiting));

    const resumed = await ask(messages, "conversation-lost-loop");

    // The model carries on from the result: the next call reads the next chunk.
    assert.deepEqual(
      resumed.content.filter((block) => block.type === "tool_use").map((block) => block.input),
      [{ url: "https://docs.example/llms-full.txt", offset: 40_000 }],
    );

    const replayed = JSON.stringify(requests.at(-1)?.body.messages);

    // Resumed at the last finished turn, which Claude Code still has on record; only the lost
    // round is replayed, once, with its output labelled as the result of the call before it.
    assert.match(replayed, /Get ready/);
    assert.doesNotMatch(replayed, /\[Your previous reply\]\\nReady to read/);
    assert.equal(replayed.split("Read it").length - 1, 1);
    assert.match(replayed, /\[called tool web_fetch with/);
    assert.match(replayed, /\[tool result\]\\nChunk at 0\. Next offset: 40000/);
    assert.doesNotMatch(replayed, TURN_ENDING);
  },
);

test("hands over a complete tool call from a reply that hit the output limit", async () => {
  replies.push(
    {
      content: [
        { type: "text", text: "Reading the page." },
        {
          type: "tool_use",
          id: "toolu_limit",
          name: "mcp__dolly__web_fetch",
          input: { url: "https://docs.example/llms-full.txt", offset: 0 },
        },
      ],
      stop: "max_tokens",
    },
    { content: [{ type: "text", text: "Got the first chunk." }], stop: "end_turn" },
  );

  const messages: ClientMessage[] = [{ role: "user", content: "Read the page" }];
  const reply = await ask(messages, "conversation-output-limit");

  // Claude Code runs the call, so it reaches the client instead of waiting forever.
  assert.deepEqual(
    reply.content.filter((block) => block.type === "tool_use").map((block) => block.id),
    ["toolu_limit"],
  );

  messages.push(
    { role: "assistant", content: reply.content },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_limit", content: chunk(0) }],
    },
  );

  const answer = await ask(messages, "conversation-output-limit");

  assert.deepEqual(answer.content, [{ type: "text", text: "Got the first chunk." }]);
  assert.deepEqual(
    lastResults(requests[1]!.body).map((block) => [block.tool_use_id, resultText(block)]),
    [["toolu_limit", chunk(0)]],
  );
});

test("moves on when the client abandons a tool loop for a new prompt", async () => {
  script = chunkReader;
  const before = claudeProcesses();
  const messages: ClientMessage[] = [{ role: "user", content: "Read the whole page" }];
  const reply = await ask(messages, "conversation-abandoned");

  assert.equal(reply.stop_reason, "tool_use");
  const waiting = claudeProcesses().filter((pid) => !before.includes(pid));

  // The owner stopped the run before the tool finished, then asked something else.
  script = undefined;
  replies.push({ content: [{ type: "text", text: "Hi there" }], stop: "end_turn" });
  messages.push(
    { role: "assistant", content: reply.content },
    { role: "user", content: "Just say hi" },
  );

  const answer = await ask(messages, "conversation-abandoned");

  assert.deepEqual(answer.content, [{ type: "text", text: "Hi there" }]);
  // The abandoned call is never answered upstream: no model call beyond the new prompt's.
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests.at(-1)?.body.messages), /Just say hi/);

  // The process waiting on the abandoned call is gone.
  if (procfs) await waitFor(() => waiting.every((pid) => !claudeProcesses().includes(pid)));
});

test("delivers a message sent beside tool results within the same turn", async () => {
  script = chunkReader;
  const messages: ClientMessage[] = [{ role: "user", content: "Read the whole page" }];
  const reply = await ask(messages, "conversation-steered");

  script = undefined;
  replies.push({ content: [{ type: "text", text: "Footer checked too." }], stop: "end_turn" });
  messages.push(
    { role: "assistant", content: reply.content },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_chunk_0", content: chunk(0) }],
    },
    { role: "user", content: "Also check the footer" },
  );

  const answer = await ask(messages, "conversation-steered");

  assert.deepEqual(answer.content, [{ type: "text", text: "Footer checked too." }]);
  assert.equal(requests.length, 2);
  const upstream = requests[1]!.body;

  // The result answers the call, and the message follows it in the same model call.
  assert.match(JSON.stringify(upstream.messages), /"tool_use_id":"toolu_chunk_0"/);
  assert.match(JSON.stringify(upstream.messages), /Also check the footer/);
  assert.doesNotMatch(JSON.stringify(upstream), TURN_ENDING);
});

test("starts a new Claude Code process when a request needs different options", async () => {
  const conversation = [{ role: "user" as const, content: "First" }];

  replies.push({ content: [{ type: "text", text: "One" }], stop: "end_turn" });
  const before = claudeProcesses();

  await events(await send({ max_tokens: 4096, messages: conversation }, "conversation-options"));
  const first = claudeProcesses().filter((pid) => !before.includes(pid));

  replies.push({ content: [{ type: "text", text: "Two" }], stop: "end_turn" });

  const response = await events(
    await send(
      {
        max_tokens: 2048,
        messages: [
          ...conversation,
          { role: "assistant", content: [{ type: "text", text: "One" }] },
          { role: "user", content: "Second" },
        ],
      },
      "conversation-options",
    ),
  );

  assert.match(JSON.stringify(response), /Two/);

  if (procfs) {
    assert.equal(first.length, 1);
    await waitFor(() => first.every((pid) => !claudeProcesses().includes(pid)));
    assert.equal(claudeProcesses().filter((pid) => !before.includes(pid)).length, 1);
  }

  assert.equal(requests[1]?.body.max_tokens, 2048);
  // The new process resumes the SDK session rather than replaying the conversation.
  assert.doesNotMatch(JSON.stringify(requests[1]?.body.messages), /\[Your previous reply\]/);
});

test("answers on a fresh process when the waiting one has exited", linux, async () => {
  const conversation = [{ role: "user" as const, content: "Before the crash" }];

  replies.push({ content: [{ type: "text", text: "Noted" }], stop: "end_turn" });
  const before = claudeProcesses();

  await events(await send({ messages: conversation }, "conversation-crash"));
  const [waiting] = claudeProcesses().filter((pid) => !before.includes(pid));

  assert.ok(waiting);
  process.kill(waiting, "SIGKILL");
  await waitFor(() => !claudeProcesses().includes(waiting));

  replies.push({ content: [{ type: "text", text: "Still here" }], stop: "end_turn" });

  const response = await events(
    await send(
      {
        messages: [
          ...conversation,
          { role: "assistant", content: [{ type: "text", text: "Noted" }] },
          { role: "user", content: "After the crash" },
        ],
      },
      "conversation-crash",
    ),
  );

  assert.match(JSON.stringify(response), /Still here/);
  const resumed = JSON.stringify(requests.at(-1)?.body.messages);

  assert.match(resumed, /Before the crash/);
  assert.match(resumed, /After the crash/);
  assert.doesNotMatch(resumed, /\[Your previous reply\]/);
});

test("retries a turn whose process died mid-answer without doubling it", linux, async () => {
  const conversation = [{ role: "user" as const, content: "Question one" }];

  replies.push({ content: [{ type: "text", text: "Answer one" }], stop: "end_turn" });
  const before = claudeProcesses();

  await events(await send({ messages: conversation }, "conversation-mid-turn"));
  const [waiting] = claudeProcesses().filter((pid) => !before.includes(pid));

  assert.ok(waiting);
  partialNext = true;

  const pending = send(
    {
      messages: [
        ...conversation,
        { role: "assistant", content: [{ type: "text", text: "Answer one" }] },
        { role: "user", content: "Question two" },
      ],
    },
    "conversation-mid-turn",
  );

  // The waiting process takes the turn, streams part of an answer, and dies.
  await partialSent;
  // Long enough for Claude Code to write the turn so far to its transcript.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  process.kill(waiting, "SIGKILL");
  replies.push({ content: [{ type: "text", text: "Answer two" }], stop: "end_turn" });

  const response = JSON.stringify(await events(await pending));

  assert.match(response, /Answer two/);
  assert.doesNotMatch(response, /PARTIAL ANSWER/);
  const retried = JSON.stringify(requests.at(-1)?.body.messages);

  // Resumed at the last turn the client received: the lost turn is dropped, not replayed twice.
  assert.match(retried, /Question one/);
  assert.match(retried, /Answer one/);
  assert.equal(retried.split("Question two").length - 1, 1);
  assert.doesNotMatch(retried, /PARTIAL ANSWER/);
  assert.doesNotMatch(retried, /\[Your previous reply\]/);
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

test("replays instead of resuming when the session id last carried another conversation", async () => {
  // Compaction's summarizer shares the conversation's session id with a history of its own.
  replies.push({ content: [{ type: "text", text: "Summary written" }], stop: "end_turn" });
  await events(
    await send(
      { messages: [{ role: "user", content: "Summarize this conversation" }] },
      "conversation-compacted",
    ),
  );

  replies.push({ content: [{ type: "text", text: "Carrying on" }], stop: "end_turn" });

  const response = await events(
    await send(
      {
        messages: [
          { role: "user", content: "Summary of earlier work" },
          { role: "assistant", content: [{ type: "text", text: "Understood" }] },
          { role: "user", content: "Continue" },
        ],
      },
      "conversation-compacted",
    ),
  );

  assert.match(JSON.stringify(response), /Carrying on/);

  const replayed = JSON.stringify(requests[1]?.body.messages);

  assert.match(replayed, /Summary of earlier work/);
  assert.match(replayed, /\[Your previous reply\]\\nUnderstood/);
  assert.doesNotMatch(replayed, /Summarize this conversation/);
});

test("accepts a prompt with images past 10 MiB, as Dolly allows", async () => {
  replies.push({ content: [{ type: "text", text: "Two images" }], stop: "end_turn" });

  const image = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png" as const,
      data: Buffer.alloc(4 * 1024 * 1024, 7).toString("base64"),
    },
  };

  const response = await send(
    {
      stream: false,
      messages: [{ role: "user", content: [image, image, { type: "text", text: "Compare" }] }],
    },
    "conversation-images",
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).content, [{ type: "text", text: "Two images" }]);
});

test("refuses a body past Anthropic's request limit", async () => {
  const response = await send(
    { messages: [{ role: "user", content: "x".repeat(33 * 1024 * 1024) }] },
    "conversation-huge",
  );

  assert.equal(response.status, 413);
  assert.equal(requests.length, 0);
});
