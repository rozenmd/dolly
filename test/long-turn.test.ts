import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { HistoryPage, Live, PromptIndex, Snapshot } from "../src/transcript";
import { extendTranscript, prependHistory } from "../web/src/lib/transcript-history";

/**
 * A long tool-using turn outgrows Pi's default 50-entry transcript window. A freshly
 * opened view must still start at the turn's prompt, and its final answer must be the
 * newest entry, with the run settled and no failure, over both the HTTP read and the
 * live WebSocket.
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

function claude(blocks: ClaudeBlock[], stop: "tool_use" | "end_turn", inputTokens = 10) {
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
        usage: { input_tokens: inputTokens, output_tokens: 0 },
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
function longTurnModel(rounds = ROUNDS) {
  let round = 0;

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    round += 1;

    if (round > rounds)
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

/** The window starts at the turn's prompt, though the turn holds more than 50 entries. */
function expectPrompt(snapshot: typeof Snapshot.Type) {
  expect(snapshot.entries.length).toBeGreaterThan(50);
  expect(snapshot.entries[0]?.kind).toBe("pi.user");
  expect(snapshot.entries[0]?.model?.[0]).toMatchObject({ role: "user", content: "Explore" });
}

async function openStream(id: string) {
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

  return { socket, updates };
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

async function prompt(id: string, content = "Explore") {
  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);
}

beforeEach(async () => {
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("credential:anthropic");
    await state.storage.delete("credential:openai");
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("keeps the prompt and final answer of a long turn in a freshly opened view", async () => {
  const model = longTurnModel();
  const id = await claudeSession();
  await prompt(id);

  const read = async () =>
    decode(await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text());

  await expect.poll(async () => settled(await read()), { timeout: 30_000 }).toBe(true);
  expect(model.rounds()).toBe(ROUNDS + 1);
  const snapshot = await read();
  expectPrompt(snapshot);
  expectFinalAnswer(snapshot);
});

it("streams the final answer of a long turn over the live WebSocket", async () => {
  const model = longTurnModel();
  const id = await claudeSession();

  const { socket, updates } = await openStream(id);

  try {
    await expect.poll(() => updates.length).toBeGreaterThan(0);
    await prompt(id);
    await expect.poll(() => model.rounds(), { timeout: 30_000 }).toBe(ROUNDS + 1);

    await expect.poll(() => settled(decode(updates.at(-1) ?? "")), { timeout: 10_000 }).toBe(true);

    expectFinalAnswer(decode(updates.at(-1) ?? ""));
  } finally {
    socket.close();
  }

  // Reopening the view, as a page reload does, starts it at the prompt again.
  const reopened = await openStream(id);

  try {
    await expect.poll(() => reopened.updates.length).toBeGreaterThan(0);
    const snapshot = decode(reopened.updates[0] ?? "");
    expectPrompt(snapshot);
    expectFinalAnswer(snapshot);
  } finally {
    reopened.socket.close();
  }
});

const decodePage = Schema.decodeUnknownSync(Schema.fromJsonString(HistoryPage));

async function history(id: string, through: number, limit?: number) {
  const query = new URLSearchParams({ through: String(through) });

  if (limit !== undefined) query.set("limit", String(limit));

  return SELF.fetch(`https://worker/api/sessions/${id}/history?${query}`, { headers });
}

/** Scrolls back as the browser does: fetch pages before the oldest held entry until none remain. */
async function scrollBack(id: string, snapshot: typeof Snapshot.Type, limit?: number) {
  let held = snapshot;
  let pages = 0;

  while (held.before !== undefined) {
    const through = held.before;
    const response = await history(id, through, limit);
    expect(response.status).toBe(200);
    held = prependHistory(held, through, decodePage(await response.text()));
    pages += 1;
  }

  return { held, pages };
}

it("pages a long turn's history back to its prompt, oldest first", async () => {
  longTurnModel();
  const id = await claudeSession();
  await prompt(id);

  const read = async () =>
    decode(await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text());

  await expect.poll(async () => settled(await read()), { timeout: 30_000 }).toBe(true);
  const full = await read();
  const newest = full.entries.at(-1)?.id ?? 0;

  // Pretend the window held only the final answer, then scroll back in pages of 10.
  const { held, pages } = await scrollBack(
    id,
    { ...full, entries: full.entries.slice(-1), before: full.entries.at(-2)?.id },
    10,
  );

  expect(pages).toBe(Math.ceil((full.entries.length - 1) / 10));
  expect(held.entries.map((entry) => entry.id)).toEqual(full.entries.map((entry) => entry.id));
  expect(held.before).toBeUndefined();
  expectPrompt(held);
  expectFinalAnswer(held);

  // A single default page covers it, starting at the conversation's first entry.
  const page = decodePage(await (await history(id, newest)).text());
  expect(page.before).toBeUndefined();
  expect(page.entries.map((entry) => entry.id)).toEqual(full.entries.map((entry) => entry.id));

  expect((await history(id, newest, 0)).status).toBe(400);
  expect((await history(id, newest, 201)).status).toBe(400);
  expect((await SELF.fetch(`https://worker/api/sessions/${id}/history`, { headers })).status).toBe(
    400,
  );
  expect((await history("missing", newest)).status).toBe(404);
});

/** The browser's ids for the turns its prompts start: `${entryId}-${messageIndex}` (web/src/lib/api.ts). */
const userMessages = (snapshot: typeof Snapshot.Type) =>
  snapshot.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message, index) =>
      message.role === "user" ? [`${entry.id}-${index}`] : [],
    ),
  );

const decodeIndex = Schema.decodeUnknownSync(Schema.fromJsonString(PromptIndex));

const prompts = (id: string, through: number | string) =>
  SELF.fetch(`https://worker/api/sessions/${id}/prompts?through=${through}`, { headers });

it("indexes every prompt before a window, with each turn's answer, for the rail", async () => {
  longTurnModel();
  const id = await claudeSession();

  const read = async () =>
    decode(await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text());

  await prompt(id);
  await expect.poll(async () => settled(await read()), { timeout: 30_000 }).toBe(true);
  await prompt(id, "Again");

  // The second turn answers at once, so the newest entry is its answer.
  await expect
    .poll(
      async () => {
        const snapshot = await read();

        const messages = snapshot.entries.flatMap((entry) => entry.model ?? []);
        const again = messages.findIndex((message) => message.content === "Again");

        return (
          settled(snapshot) &&
          again >= 0 &&
          messages.at(-1)?.role === "assistant" &&
          messages.length - 1 > again
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // Scrolled all the way back, the browser holds the same prompts the index names.
  const { held } = await scrollBack(id, {
    ...(await read()),
    entries: [],
    before: (await read()).entries.at(-1)?.id,
  });

  const newest = held.entries.at(-1)?.id ?? 0;
  const all = decodeIndex(await (await prompts(id, newest)).text()).prompts;

  expect(all.map((mark) => mark.id)).toEqual(userMessages(held));
  expect(all).toMatchObject([
    { text: "Explore", reply: "FINAL ANSWER" },
    { text: "Again", reply: "FINAL ANSWER" },
  ]);
  expect(all[0]?.at).toBeTypeOf("number");

  // Indexing only up to the second prompt still reads the first turn through to its answer.
  const second = Number.parseInt(all[1]?.id ?? "", 10);
  const earlier = decodeIndex(await (await prompts(id, second - 1)).text()).prompts;
  expect(earlier).toEqual([all[0]]);

  expect((await prompts(id, -1)).status).toBe(400);
  expect((await prompts(id, "x")).status).toBe(400);
  expect((await prompts("missing", newest)).status).toBe(404);
});

// The outer timeout must cover the generation and stream-settlement polls (30s + 10s).
it("keeps the live prompt after a turn outgrows the window", { timeout: 45_000 }, async () => {
  // 40 rounds of three entries pass the 100-entry window, which then drops the prompt.
  const rounds = 40;
  const model = longTurnModel(rounds);
  const id = await claudeSession();
  const { socket, updates } = await openStream(id);

  try {
    await expect.poll(() => updates.length).toBeGreaterThan(0);
    await prompt(id);
    await expect.poll(() => model.rounds(), { timeout: 30_000 }).toBe(rounds + 1);
    await expect.poll(() => settled(decode(updates.at(-1) ?? "")), { timeout: 10_000 }).toBe(true);
  } finally {
    socket.close();
  }

  const last = decode(updates.at(-1) ?? "");
  expect(last.before).toBeDefined();
  expect(last.entries.some((entry) => entry.kind === "pi.user")).toBe(false);

  // Folding every update in as the browser does keeps all entries since the prompt.
  const held = updates
    .map((update) => decode(update))
    .reduce<typeof Snapshot.Type | null>(extendTranscript, null);

  if (!held) throw new Error("Expected streamed snapshots");
  expect(held.before).toBeUndefined();
  expectPrompt(held);
  expectFinalAnswer(held);

  // A browser that joined late scrolls back from the last window to the same transcript.
  const { held: scrolled } = await scrollBack(id, last);
  expect(scrolled.entries.map((entry) => entry.id)).toEqual(held.entries.map((entry) => entry.id));
});

it.each(["threshold", "overflow"])(
  "automatically compacts on %s without losing the durable transcript",
  async (trigger) => {
    const oldest = "Original request: keep the files in src/";
    const recent = "Recent work to keep verbatim: " + "test fixture ".repeat(2_000).trimEnd();
    const priorAnswer = "Second answer: " + "more test output ".repeat(2_800).trimEnd();
    const latest = "Continue the work";
    const summary = "Checkpoint: the user wants the files kept in src/.";

    const replies = [
      () => claude([{ type: "text", text: "First answer" }], "end_turn"),
      // A 1M-window Haiku session should compact just above OpenSession's 440k cap.
      () =>
        claude(
          [{ type: "text", text: priorAnswer }],
          "end_turn",
          trigger === "threshold" ? 450_000 : 10,
        ),
      ...(trigger === "overflow"
        ? [
            () =>
              Response.json(
                { error: { type: "invalid_request_error", message: "prompt is too long" } },
                { status: 400 },
              ),
          ]
        : []),
      () => claude([{ type: "text", text: summary }], "end_turn"),
      () => claude([{ type: "text", text: "Continued successfully" }], "end_turn"),
      () => claude([{ type: "text", text: "Answered after restart" }], "end_turn"),
    ];

    const requests: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(
        await (input instanceof Request ? input.clone() : new Response(init?.body)).text(),
      );

      return (
        replies.shift()?.() ??
        Response.json({ error: { message: "Unexpected request" } }, { status: 400 })
      );
    });

    const id = await claudeSession();
    const url = `https://worker/api/sessions/${id}`;
    const read = async () => decode(await (await SELF.fetch(url, { headers })).text());

    const waitForAnswer = async (text: string) =>
      expect
        .poll(
          async () => {
            const snapshot = await read();

            return (
              !live(snapshot)?.run &&
              snapshot.entries.some((entry) =>
                entry.model?.some(
                  (message) =>
                    message.role === "assistant" &&
                    Array.isArray(message.content) &&
                    message.content.some((block) => block.type === "text" && block.text === text),
                ),
              )
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);

    await prompt(id, oldest);
    await waitForAnswer("First answer");
    await prompt(id, recent);
    await waitForAnswer(priorAnswer);
    expect(requests).toHaveLength(2);

    await prompt(id, latest);
    await waitForAnswer("Continued successfully");
    const snapshot = await read();

    expect(live(snapshot)?.runFailure).toBeUndefined();
    expect(snapshot.entries.filter((entry) => entry.kind === "pi.compaction")).toMatchObject([
      { data: { reason: trigger } },
    ]);
    expect(
      snapshot.entries.some((entry) => entry.model?.some((message) => message.content === oldest)),
    ).toBe(true);

    const summaryIndex = trigger === "overflow" ? 3 : 2;
    expect(requests).toHaveLength(summaryIndex + 2);
    expect(requests[summaryIndex]).toContain(oldest);
    expect(requests[summaryIndex]).not.toContain(recent);
    expect(requests[summaryIndex]).not.toContain(latest);
    expect(requests[summaryIndex + 1]).toContain(summary);
    expect(requests[summaryIndex + 1]).toContain(recent);
    expect(requests[summaryIndex + 1]).toContain(latest);
    expect(requests[summaryIndex + 1]).not.toContain(oldest);

    await abortAllDurableObjects();
    await prompt(id, "Resume after restart");
    await waitForAnswer("Answered after restart");
    expect(requests).toHaveLength(summaryIndex + 3);
    expect(requests.at(-1)).not.toContain(oldest);
    const reopened = await read();

    expect(reopened.entries.find((entry) => entry.kind === "pi.compaction")?.model).toEqual(
      snapshot.entries.find((entry) => entry.kind === "pi.compaction")?.model,
    );
  },
  30_000,
);
