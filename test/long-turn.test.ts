import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { Live, Snapshot } from "../src/transcript";

/**
 * A long tool-using turn outgrows Pi's 50-entry transcript window, so its prompt
 * leaves a freshly opened window. Its final answer must still be the newest entry, with
 * the run settled and no failure, over both the HTTP read and the live WebSocket.
 */

const token = `sk-ant-oat01-${"a".repeat(64)}`;
const ROUNDS = 25;

type ClaudeBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: { action: string } };

type ClaudeEvent = { type: string } & Record<string, string | number | ClaudeEventValue>;

type ClaudeEventValue = { [key: string]: string | number | null | ClaudeEventValue | never[] };

function blockEvents(block: ClaudeBlock, index: number): ClaudeEvent[] {
  if (block.type === "text")
    return [
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
    ];

  if (block.type === "thinking")
    return [
      { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } },
    ];

  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
    },
  ];
}

function claude(blocks: ClaudeBlock[], stop: "tool_use" | "end_turn") {
  const events: ClaudeEvent[] = [
    {
      type: "message_start",
      message: {
        id: "msg_long_turn",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    ...blocks.flatMap((block, index) => [
      ...blockEvents(block, index),
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Each round thinks, narrates and calls two tools in parallel; then the final answer. */
function longTurnModel() {
  let round = 0;

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    round += 1;

    if (round > ROUNDS)
      return claude(
        [
          { type: "thinking", thinking: "done" },
          { type: "text", text: "FINAL ANSWER" },
        ],
        "end_turn",
      );

    return claude(
      [
        { type: "thinking", thinking: "looking" },
        { type: "text", text: `Checking ${round}` },
        { type: "tool_use", id: `toolu_${round}a`, name: "papercuts", input: { action: "list" } },
        { type: "tool_use", id: `toolu_${round}b`, name: "papercuts", input: { action: "list" } },
      ],
      "tool_use",
    );
  });

  return { fetch, rounds: () => round };
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot));

const live = (snapshot: typeof Snapshot.Type) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Live)(snapshot.docs["pi.live"]));

const settled = (snapshot: typeof Snapshot.Type) => {
  const state = live(snapshot);

  return state !== undefined && state.run === undefined && snapshot.entries.length > 2;
};

function expectFinalAnswer(snapshot: typeof Snapshot.Type) {
  expect(live(snapshot)?.runFailure).toBeUndefined();
  expect(snapshot.entries.at(-1)?.model?.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "done" },
      { type: "text", text: "FINAL ANSWER" },
    ],
  });
}

async function claudeSession() {
  const saved = await SELF.fetch("https://worker/api/auth/anthropic", {
    method: "PUT",
    headers,
    body: JSON.stringify({ token }),
  });

  expect(saved.status).toBe(200);

  const created = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-haiku-5-5" }),
  });

  return (await created.json<{ id: string }>()).id;
}

async function prompt(id: string) {
  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Explore", requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);
}

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

it("keeps the final answer of a long turn whose prompt left the transcript window", async () => {
  const model = longTurnModel();
  const id = await claudeSession();
  await prompt(id);

  const read = async () =>
    decode(await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text());

  await expect.poll(async () => settled(await read()), { timeout: 30_000 }).toBe(true);
  expect(model.rounds()).toBe(ROUNDS + 1);
  const snapshot = await read();
  // A freshly opened view holds the newest 50 entries, which no longer reach the prompt.
  expect(snapshot.before).toBeDefined();
  expect(snapshot.entries.some((entry) => entry.kind === "pi.user")).toBe(false);
  expectFinalAnswer(snapshot);
});

it("streams the final answer of a long turn over the live WebSocket", async () => {
  const model = longTurnModel();
  const id = await claudeSession();

  const stream = await SELF.fetch(`https://worker/api/sessions/${id}/events`, {
    headers: { ...headers, Upgrade: "websocket", Origin: "https://worker" },
  });

  const socket = stream.webSocket;

  if (!socket) throw new Error("Expected a session WebSocket");
  const updates: string[] = [];

  socket.addEventListener("message", (event) => {
    updates.push(String(event.data));
  });
  socket.accept();

  try {
    await expect.poll(() => updates.length).toBeGreaterThan(0);
    await prompt(id);
    await expect.poll(() => model.rounds(), { timeout: 30_000 }).toBe(ROUNDS + 1);

    await expect.poll(() => settled(decode(updates.at(-1) ?? "")), { timeout: 10_000 }).toBe(true);

    expectFinalAnswer(decode(updates.at(-1) ?? ""));
  } finally {
    socket.close();
  }
});
