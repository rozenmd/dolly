import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

/** The title Dolly gets for every automatic or `retitle_session` title request in these tests. */
export const TEST_TITLE = "Test session title";

/** The text a fetch would send, read without consuming the caller's body. */
async function body(input: RequestInfo | URL, init?: RequestInit) {
  const sent = init?.body;

  if (Schema.is(Schema.String)(sent)) return sent;

  if (input instanceof Request && !input.bodyUsed) return input.clone().text();

  return "";
}

/** A Claude Messages SSE stream answering `text`. */
function claude(text: string) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_title",
        type: "message",
        role: "assistant",
        model: "claude-haiku",
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
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A Codex Responses SSE stream answering `text`. */
function codex(text: string) {
  const item = {
    type: "message",
    id: "msg_title",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };

  const events = [
    { type: "response.created", response: { id: "resp_title", status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_title",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * Whether a fetch is a session title request (session-title.ts): a tool-less one-shot whose
 * prompt asks for a "short title", sent after a session's first run or by `retitle_session`.
 */
export async function isTitleRequest(input: RequestInfo | URL, init?: RequestInit) {
  return (await body(input, init)).includes("short title");
}

/**
 * The answer to a title request, in the provider's stream format; undefined for any other request.
 * An empty `title` is an unusable answer, so the session keeps its first-line title.
 */
export async function titleResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
  title: string = TEST_TITLE,
) {
  if (!(await isTitleRequest(input, init))) return undefined;

  const url = input instanceof Request ? input.url : String(input);

  return url.includes("/v1/messages") ? claude(title) : codex(title);
}

/**
 * Mock `globalThis.fetch` with `implementation`, answering title requests with `title` first.
 * Returns the mock behind it: title requests never reach it, so they don't take a queued
 * response or show up in its calls, and `mockImplementationOnce` still queues model answers.
 */
export function mockFetch(implementation?: typeof fetch, title: string = TEST_TITLE) {
  const model = vi.fn<typeof fetch>(implementation);

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input, init) => (await titleResponse(input, init, title)) ?? model(input, init),
  );

  return model;
}
