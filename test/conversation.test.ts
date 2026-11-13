import { env } from "cloudflare:workers";
import { zstdDecompressSync } from "node:zlib";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { Snapshot, Live } from "../src/transcript";

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

beforeEach(async () => {
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
});

afterEach(() => vi.restoreAllMocks());

it("leaves new conversations unlimited and removes persisted limits on restart", async () => {
  const created = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
  });

  expect(created.status).toBe(201);

  const { id } = await created.json<{ id: string }>();

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const harness = agent["harness"];
    const conversationId = await state.storage.get<ConversationId>(`session:${id}`);

    if (!conversationId) throw new Error("Session missing");

    const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
    expect((await conversation!.agent(BACKGROUND_CONTEXT)).maxTurns).toBeUndefined();
    await harness.commit(
      (tx) => configure(tx, conversationId, { maxTurns: 20 }),
      BACKGROUND_CONTEXT,
    );
    await state.storage.delete("migration:unlimited-turns");
  });

  await abortAllDurableObjects();
  await SELF.fetch(`https://worker/api/sessions/${id}`, { headers });

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const harness = agent["harness"];
    const conversationId = await state.storage.get<ConversationId>(`session:${id}`);

    if (!conversationId) throw new Error("Session missing");

    const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
    expect((await conversation!.agent(BACKGROUND_CONTEXT)).maxTurns).toBeUndefined();
    expect(await state.storage.get("migration:unlimited-turns")).toBe(true);
  });
});

it("pushes an initial snapshot and redacted live updates over an authenticated WebSocket", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "Model unavailable" } }, { status: 400 }),
  );

  const created = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
  });

  const { id } = await created.json<{ id: string }>();

  const response = await SELF.fetch(`https://worker/api/sessions/${id}/events`, {
    headers: { ...headers, Upgrade: "websocket", Origin: "https://worker" },
  });

  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const snapshots: Array<typeof Snapshot.Type> = [];
  socket.addEventListener("message", (event) => {
    expect(String(event.data)).not.toContain("test-refresh");
    snapshots.push(Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(event.data));
  });
  socket.accept();

  try {
    await expect.poll(() => snapshots.length).toBe(1);

    const submitted = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "hide test-refresh", requestId: crypto.randomUUID() }),
    });

    expect(submitted.status).toBe(202);
    await expect
      .poll(() =>
        snapshots
          .at(-1)
          ?.entries.some((entry) =>
            entry.model?.some(
              (message) => message.role === "user" && message.content === "hide [redacted]",
            ),
          ),
      )
      .toBe(true);
    await expect
      .poll(() => {
        const snapshot = snapshots.at(-1);

        return (
          snapshot && Schema.decodeUnknownSync(Live)(snapshot.docs["pi.live"]).runFailure?.reason
        );
      })
      .toBe("model_error");
  } finally {
    socket.close();
  }
});

it("retains model failure details in the real transcript and browser live-state contract", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json(
      {
        error: {
          message: "The selected model is unavailable for this account",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      { status: 400 },
    ),
  );

  const response = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-6.1-terra" }),
  });

  const { id } = await response.json<{ id: string }>();

  const submitted = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "hi", requestId: crypto.randomUUID() }),
  });

  expect(submitted.status).toBe(202);

  const read = async () =>
    Schema.decodeUnknownSync(Snapshot)(
      await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).json(),
    );

  await expect
    .poll(
      async () => {
        const snapshot = await read();

        return Schema.decodeUnknownSync(Live)(snapshot.docs["pi.live"]).runFailure?.reason;
      },
      { timeout: 4000 },
    )
    .toBe("model_error");
  await abortAllDurableObjects();
  const snapshot = await read();
  const live = Schema.decodeUnknownSync(Live)(snapshot.docs["pi.live"]);
  expect(live.run).toBeUndefined();
  expect(live.runFailure?.detail).toContain("The selected model is unavailable");

  const assistant = snapshot.entries
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "assistant");

  expect(assistant?.stopReason).toBe("error");
  expect(assistant?.errorMessage).toContain("The selected model is unavailable");
  expect(assistant?.content).toEqual([]);
});

it.each([
  { model: undefined, expectedModel: "gpt-6-luna" },
  { model: "gpt-6-sol", expectedModel: "gpt-6-sol" },
])(
  "runs $expectedModel through the Codex SSE adapter with durable model selection and deduplication",
  async ({ model, expectedModel }) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toContain("chatgpt.com/backend-api/codex/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${access}`);
      expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("test-account");

      const encoded = await new Response(init?.body).arrayBuffer();

      const bytes =
        new Headers(init?.headers).get("content-encoding") === "zstd"
          ? zstdDecompressSync(new Uint8Array(encoded))
          : new Uint8Array(encoded);

      const request = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ model: Schema.String })),
      )(new TextDecoder().decode(bytes));

      expect(request.model).toBe(expectedModel);

      const message = {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello from Codex", annotations: [] }],
      };

      const events = [
        {
          type: "response.created",
          response: { id: "resp_test", status: "in_progress", output: [] },
        },
        { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          item_id: "msg_test",
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg_test",
          delta: "Hello from Codex",
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.completed",
          response: {
            id: "resp_test",
            status: "completed",
            output: [message],
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ];

      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });

    const created = await SELF.fetch("https://worker/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model }),
    });

    expect(created.status).toBe(201);
    const session = await created.json<{ id: string; model: string }>();
    expect(session.model).toBe(expectedModel);
    const { id } = session;
    const other = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
    expect(other.status).toBe(201);
    expect(await other.json()).toMatchObject({ model: "gpt-6-luna" });
    // Creating another session and recovering the object must not change this model.
    await abortAllDurableObjects();

    const body = JSON.stringify({
      content: "Say hello. Use Bearer abc",
      requestId: crypto.randomUUID(),
    });

    const submit = () =>
      SELF.fetch(`https://worker/api/sessions/${id}/messages`, { method: "POST", headers, body });

    const first = await submit();
    expect(first.status).toBe(202);
    const receipt = await first.json();
    const second = await submit();
    expect(await second.json()).toEqual(receipt);
    await expect
      .poll(
        async () => {
          const response = await SELF.fetch(`https://worker/api/sessions/${id}`, { headers });

          return response.text();
        },
        { timeout: 4000 },
      )
      .toContain("Hello from Codex");
    expect(fetch).toHaveBeenCalledTimes(1);
    await abortAllDurableObjects();
    const transcript = await SELF.fetch(`https://worker/api/sessions/${id}`, { headers });
    expect(transcript.status).toBe(200);
    expect(transcript.headers.get("Content-Type")).toContain("application/json");
    const snapshot = await transcript.json();
    // Decode a real Pi transcript with the browser contract, not a hand-written wire fixture.
    const browserSnapshot = Schema.decodeUnknownSync(Snapshot)(snapshot);
    expect(browserSnapshot.entries.length).toBeGreaterThan(0);
    expect(
      browserSnapshot.entries.some((entry) =>
        entry.model?.some((message) => message.role === "assistant"),
      ),
    ).toBe(true);
    const text = JSON.stringify(snapshot);
    expect(text).toContain("Use Bearer [redacted]");
    expect(text).not.toContain("Bearer abc");
    expect(text).toContain("Hello from Codex");
    expect(text).not.toContain(access);
    expect(text).not.toContain("test-refresh");
  },
);
