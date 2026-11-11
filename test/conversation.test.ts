import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const headers = { Authorization: "Bearer test-token-with-at-least-32-characters" };
const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

beforeEach(async () => {
  await reset();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", { type: "oauth", access, refresh: "test-refresh", expires: Date.now() + 3_600_000 });
  });
});
afterEach(() => vi.restoreAllMocks());

it("runs a durable prompt through the Codex SSE adapter, deduplicates requests, and recovers its transcript", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toContain("chatgpt.com/backend-api/codex/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${access}`);
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("test-account");
    const message = { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello from Codex", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_test", part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_test", delta: "Hello from Codex" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp_test", status: "completed", output: [message], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  });
  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();
  const body = JSON.stringify({ content: "Say hello", requestId: crypto.randomUUID() });
  const submit = () => SELF.fetch(`https://worker/api/sessions/${id}/messages`, { method: "POST", headers, body });
  const first = await submit();
  expect(first.status).toBe(202);
  const receipt = await first.json();
  const second = await submit();
  expect(await second.json()).toEqual(receipt);
  await expect.poll(async () => {
    const response = await SELF.fetch(`https://worker/api/sessions/${id}`, { headers });
    return response.text();
  }, { timeout: 4000 }).toContain("Hello from Codex");
  expect(fetch).toHaveBeenCalledTimes(1);
  await abortAllDurableObjects();
  const transcript = await SELF.fetch(`https://worker/api/sessions/${id}`, { headers });
  const text = await transcript.text();
  expect(text).toContain("Hello from Codex");
  expect(text).not.toContain(access);
  expect(text).not.toContain("test-refresh");
});
