import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { mockFetch } from "./titles";
import { Live, Snapshot } from "../src/transcript";
import { STEER_TOOL_SKIP } from "../src/steer-interrupt";

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

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
  });
});

afterEach(() => vi.restoreAllMocks());

/** The Codex Responses stream events these tests send. */
type SseEvent = {
  readonly type: string;
  readonly response?: object;
  readonly output_index?: number;
  readonly summary_index?: number;
  readonly item?: object;
  readonly delta?: string;
};

const encoder = new TextEncoder();

const sse = (events: readonly SseEvent[]) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/**
 * A Codex response stream the mock writes to. Writes must come from the Durable Object's context
 * (inside the fetch mock), not the test's. The adapter aborts a streaming response by cancelling
 * its body, which `cancelled` records.
 */
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = { cancelled: false };

  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      stream.cancelled = true;
    },
  });

  return Object.assign(stream, {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    write: (events: readonly SseEvent[]) => controller.enqueue(encoder.encode(sse(events))),
    close: () => controller.close(),
  });
}

const completed = (id: string, output: readonly object[]): SseEvent => ({
  type: "response.completed",
  response: {
    id,
    status: "completed",
    output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  },
});

const answer = (text: string) => {
  const item = {
    type: "message",
    id: "msg_answer",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };

  return new Response(
    sse([
      { type: "response.created", response: { id: "resp_answer", status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item },
      completed("resp_answer", [item]),
    ]),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};

const thinkingStart = (id: string, delta: string): SseEvent[] => [
  { type: "response.created", response: { id, status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "reasoning", id: "rs_1", summary: [] },
  },
  { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta },
];

const call = (n: number) => ({
  type: "function_call",
  id: `fc_${n}`,
  call_id: `call_${n}`,
  name: "github",
  arguments: JSON.stringify({ operation: { action: "repositories" } }),
});

/** The model request body. */
async function bodyOf(init?: RequestInit) {
  const encoded = new Uint8Array(await new Response(init?.body).arrayBuffer());

  return new TextDecoder().decode(encoded);
}

/** Whether the live response has a content block of `type` yet. */
function streaming(live: typeof Live.Type, type: string) {
  const content = live.generation?.message?.content;

  if (content === undefined || Schema.is(Schema.String)(content)) return false;

  return content.some((block) => block.type === type);
}

function deferred() {
  let resolve!: () => void;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function session() {
  const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const id = (await response.json<{ id: string }>()).id;

  const send = async (content: string, steer?: boolean) => {
    const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content, requestId: crypto.randomUUID(), steer }),
    });

    expect(sent.status).toBe(202);

    return (await sent.json<{ submissionId: number }>()).submissionId;
  };

  const steer = (submissionId: number) =>
    SELF.fetch(`https://worker/api/sessions/${id}/queue/${submissionId}/steer`, {
      method: "POST",
      headers,
    });

  const read = async () =>
    Schema.decodeUnknownSync(Snapshot)(
      await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).json(),
    );

  const messages = async () =>
    (await read()).entries
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role !== "system");

  const live = async () => Schema.decodeUnknownSync(Live)((await read()).docs["pi.live"] ?? {});

  const abort = () =>
    SELF.fetch(`https://worker/api/sessions/${id}/abort`, { method: "POST", headers });

  return { send, steer, messages, live, abort };
}

it.each(["queued and promoted", "steered from the composer"])(
  "cuts a thinking-only response short and answers the steer next (%s)",
  async (how) => {
    const requests: string[] = [];
    let thinking!: ReturnType<typeof openStream>;

    mockFetch(async (url, init) => {
      if (!String(url).includes("/v1/responses")) return Response.json({}, { status: 404 });
      requests.push(await bodyOf(init));

      if (requests.length > 1) return answer("Using pnpm.");

      thinking = openStream();
      thinking.write(
        thinkingStart("resp_thinking", "Planning how to install dependencies with npm"),
      );

      return thinking.response;
    });

    const conversation = await session();

    try {
      await conversation.send("Work on this");
      await expect.poll(async () => streaming(await conversation.live(), "thinking")).toBe(true);

      if (how === "steered from the composer") await conversation.send("Actually, use pnpm", true);
      else {
        const queued = await conversation.send("Actually, use pnpm");
        expect((await conversation.steer(queued)).status).toBe(202);
      }

      // The upstream response is cancelled, and the next request carries the steer.
      await expect.poll(() => requests.length).toBe(2);
      expect(thinking.cancelled).toBe(true);
      expect(requests[1]).toContain("Actually, use pnpm");

      await expect
        .poll(async () => (await conversation.messages()).at(-1)?.content)
        .toEqual([expect.objectContaining({ type: "text", text: "Using pnpm." })]);

      const messages = await conversation.messages();
      const users = messages.filter((message) => message.role === "user").map((m) => m.content);
      expect(users).toEqual(["Work on this", "Actually, use pnpm"]);

      // The superseded thinking leaves no partial, failure or error behind.
      const assistants = messages.filter((message) => message.role === "assistant");
      expect(assistants.map((message) => message.stopReason)).toEqual(["stop", "stop"]);
      expect(assistants[0]!.content).toEqual([]);
      expect((await conversation.live()).runFailure).toBeUndefined();
    } finally {
      await conversation.abort();
    }
  },
);

it("lets a response with a tool call finish, then skips its unstarted calls for the steer", async () => {
  const requests: string[] = [];
  let calling!: ReturnType<typeof openStream>;
  const finished = deferred();

  mockFetch(async (url, init) => {
    // Skipped tools make no requests; anything else is not a model request.
    if (!String(url).includes("/v1/responses")) return Response.json({}, { status: 404 });
    requests.push(await bodyOf(init));

    if (requests.length > 1) return answer("Switched to pnpm.");

    const stream = openStream();
    calling = stream;
    stream.write([
      { type: "response.created", response: { id: "resp_tools", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...call(1), arguments: "" } },
    ]);

    // Finish the response from this context once the test has steered.
    void finished.promise.then(() => {
      stream.write([
        { type: "response.output_item.done", output_index: 0, item: call(1) },
        { type: "response.output_item.added", output_index: 1, item: call(2) },
        { type: "response.output_item.done", output_index: 1, item: call(2) },
        completed("resp_tools", [call(1), call(2)]),
      ]);
      stream.close();
    });

    return stream.response;
  });

  const conversation = await session();

  try {
    await conversation.send("Work on this");
    await expect.poll(async () => streaming(await conversation.live(), "toolCall")).toBe(true);

    const queued = await conversation.send("Actually, use pnpm");
    expect((await conversation.steer(queued)).status).toBe(202);

    // The response already called a tool, so the steer does not cut it short.
    expect(calling.cancelled).toBe(false);
    finished.resolve();

    await expect.poll(() => requests.length).toBe(2);
    expect(calling.cancelled).toBe(false);
    expect(requests[1]).toContain("Actually, use pnpm");

    await expect
      .poll(async () => (await conversation.messages()).at(-1)?.content)
      .toEqual([expect.objectContaining({ type: "text", text: "Switched to pnpm." })]);

    const messages = await conversation.messages();

    // Both calls were skipped, and the steer joined this run at the round's boundary.
    expect(
      messages
        .filter((message) => message.role === "toolResult")
        .map((message) => [message.toolCallId, message.isError, JSON.stringify(message.content)]),
    ).toEqual([
      ["call_1|fc_1", true, expect.stringContaining(STEER_TOOL_SKIP)],
      ["call_2|fc_2", true, expect.stringContaining(STEER_TOOL_SKIP)],
    ]);

    // Skipping them for the owner's steer is not a tool failure.
    const logged = await runInDurableObject(env.AGENT.getByName("owner"), (_, state) =>
      state.storage.sql
        .exec("SELECT id FROM app_papercuts WHERE message LIKE ?", `%${STEER_TOOL_SKIP}%`)
        .toArray(),
    );

    expect(logged).toEqual([]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
      "assistant",
    ]);
  } finally {
    finished.resolve();
    await conversation.abort();
  }
});

it("leaves a thinking response running when the steer is queued behind a follow-up", async () => {
  const requests: string[] = [];
  let thinking!: ReturnType<typeof openStream>;
  const finished = deferred();

  mockFetch(async (url, init) => {
    if (!String(url).includes("/v1/responses")) return Response.json({}, { status: 404 });
    requests.push(await bodyOf(init));

    if (requests.length > 1) return answer("Using pnpm.");

    const stream = openStream();
    thinking = stream;
    stream.write(thinkingStart("resp_thinking", "Planning"));

    void finished.promise.then(() => {
      stream.write([
        { type: "response.output_item.added", output_index: 1, item: call(1) },
        { type: "response.output_item.done", output_index: 1, item: call(1) },
        completed("resp_thinking", [call(1)]),
      ]);
      stream.close();
    });

    return stream.response;
  });

  const conversation = await session();

  try {
    await conversation.send("Work on this");
    await expect.poll(async () => streaming(await conversation.live(), "thinking")).toBe(true);

    await conversation.send("Then run tests");
    const queued = await conversation.send("Actually, use pnpm");
    expect((await conversation.steer(queued)).status).toBe(202);
    finished.resolve();

    // Ending the turn early would start the follow-up too, so the steer waits for the boundary
    // and the follow-up runs after the steer's turn.
    await expect.poll(() => requests.length).toBe(3);
    expect(thinking.cancelled).toBe(false);
    expect(requests[1]).toContain("Actually, use pnpm");
    expect(requests[1]).not.toContain("Then run tests");
    expect(requests[2]).toContain("Then run tests");

    await expect
      .poll(async () =>
        (await conversation.messages())
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      )
      .toEqual(["Work on this", "Actually, use pnpm", "Then run tests"]);
  } finally {
    finished.resolve();
    await conversation.abort();
  }
});
