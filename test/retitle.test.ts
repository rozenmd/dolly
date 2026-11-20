import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { SavedSession } from "../src/session-contracts";
import { headers, signIn } from "./session";

const token = `sk-ant-oat01-${"b".repeat(64)}`;

type ClaudeRequest = {
  model: string;
  tools?: { name: string }[];
  messages: unknown[];
};

/** A Claude SSE response with one text or tool_use block. */
function claude(block: { text: string } | { tool: string }) {
  const content =
    "text" in block
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: block.text },
          },
        ]
      : [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "toolu_retitle", name: block.tool, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
        ];

  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_retitle",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    ...content,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "text" in block ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Every message as JSON, enough to find the prompt text in it. */
const text = (request: ClaudeRequest) => JSON.stringify(request.messages);

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

async function sessions() {
  const response = await SELF.fetch("https://worker/api/sessions", { headers });

  return response.json<SavedSession[]>();
}

it("retitles a session on the cheapest model of the default provider", async () => {
  const titleRequests: ClaudeRequest[] = [];
  let turns = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);

    if (!request.url.includes("/v1/messages")) return new Response("{}");

    const body = await request.json<ClaudeRequest>();

    // The one-shot carries no tools; the session's own turns carry every tool.
    if (!body.tools?.length) {
      // Saving the token also probes Claude without tools.
      if (text(body).includes("short title")) titleRequests.push(body);

      return claude({ text: '"Add onboarding flow."' });
    }

    turns++;

    return turns === 1 ? claude({ tool: "retitle_session" }) : claude({ text: "Renamed" });
  });

  const saved = await SELF.fetch("https://worker/api/auth/anthropic", {
    method: "PUT",
    headers,
    body: JSON.stringify({ token }),
  });

  expect(saved.status).toBe(200);

  const created = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-sonnet-5-5" }),
  });

  const { id } = await created.json<{ id: string }>();

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Build the onboarding flow for new users\nWith three steps",
      requestId: crypto.randomUUID(),
    }),
  });

  expect(sent.status).toBe(202);

  await expect
    .poll(async () => (await sessions()).find((session) => session.id === id)?.title, {
      timeout: 10_000,
    })
    .toBe("Add onboarding flow");

  expect(titleRequests).toHaveLength(1);
  // Claude is the only connected provider, so its cheapest model names the session.
  expect(titleRequests[0]?.model).toBe("claude-haiku-5-5");
  expect(text(titleRequests[0]!)).toContain("Build the onboarding flow for new users");

  // The session keeps running on its own model.
  expect((await sessions()).find((session) => session.id === id)?.model).toBe("claude-sonnet-5-5");
});
