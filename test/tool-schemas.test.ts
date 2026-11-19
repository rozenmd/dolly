import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { headers, signIn } from "./session";

/**
 * Pi's Anthropic adapter keeps only a tool schema's root properties/required, because Anthropic
 * rejects a root anyOf. A tool whose parameters were a root union therefore reached Claude as
 * `{"properties": {}}`, so its first call always failed validation. Check the request Claude
 * actually receives.
 */

const token = `sk-ant-oat01-${"a".repeat(64)}`;

type AnthropicTool = {
  name: string;
  defer_loading?: boolean;
  input_schema: { type: string; properties: object; required: string[] };
};

function endTurn() {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_tools",
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
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
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

it("sends Claude every tool's arguments as root properties", async () => {
  const requests: { tools?: AnthropicTool[] }[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);

    if (request.url.includes("/v1/messages")) requests.push(await request.json());

    return endTurn();
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
    body: JSON.stringify({ model: "claude-haiku-5-5" }),
  });

  const { id } = await created.json<{ id: string }>();

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Log a papercut", requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);
  await expect.poll(() => requests.length).toBeGreaterThan(0);

  const tools = (requests[0]?.tools ?? []).filter((tool) => !tool.defer_loading);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name.toLowerCase(), tool]));

  expect(Object.keys(byName)).toEqual(
    expect.arrayContaining(["papercuts", "dolly", "workspace", "github"]),
  );

  // Only genuinely argument-less tools may arrive empty; a new root-union tool would show up here.
  const empty = tools.filter((tool) => Object.keys(tool.input_schema.properties).length === 0);
  expect(empty.map((tool) => tool.name)).toEqual([
    "list_children",
    "list_scheduled_prompts",
    "cancel_wait",
  ]);

  expect(byName.papercuts?.input_schema).toMatchObject({
    required: ["action"],
    properties: {
      action: { enum: ["log", "list", "resolve"] },
      message: expect.anything(),
      repository: expect.anything(),
      status: expect.anything(),
      id: expect.anything(),
    },
  });

  expect(byName.dolly?.input_schema).toMatchObject({
    required: ["action"],
    properties: {
      action: { enum: ["usage", "list_sessions", "read_session"] },
      refresh: expect.anything(),
      query: expect.anything(),
      session: expect.anything(),
      limit: expect.anything(),
    },
  });
});
