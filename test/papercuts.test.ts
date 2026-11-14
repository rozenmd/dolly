import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import { Papercuts, toolFailure } from "../src/papercuts";
import { headers, signIn } from "./session";

beforeEach(async () => {
  await reset();
  await signIn();
});

afterEach(() => vi.restoreAllMocks());

it("stores each occurrence across conversations, filters and resolves without deleting history", async () => {
  const stub = env.AGENT.getByName("owner");

  const id = await runInDurableObject(stub, async (_, state) => {
    const store = new Papercuts(state.storage.sql);

    const first = store.log({
      conversationId: "a",
      repository: "Org/Repo",
      kind: "error",
      source: "tool:shell",
      message: "Build failed",
    });

    store.log({
      conversationId: "b",
      repository: "org/repo",
      kind: "error",
      source: "tool:shell",
      message: "Build failed",
    });
    store.log({ kind: "improvement", source: "agent", message: "Setup needs documentation" });
    expect(store.list()).toHaveLength(3);
    expect(store.list("ORG/REPO")).toHaveLength(2);
    expect(() => store.log({ kind: "improvement", source: "agent", message: "  " })).toThrow(
      "empty",
    );
    expect(store.resolve(first.id)).toEqual({ resolved: true });
    expect(store.resolve(first.id)).toEqual({ resolved: false });
    expect(store.resolve("missing")).toEqual({ resolved: false });
    expect(store.list("org/repo")).toHaveLength(1);
    expect(store.list("org/repo", "fixed")[0].id).toBe(first.id);

    return first.id;
  });

  await abortAllDurableObjects();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);
    expect(store.list()).toHaveLength(2);
    expect(store.list(undefined, "fixed")[0].id).toBe(id);
  });
});

it("recognizes exceptions, diagnostics, JSON failures and shell exit codes without matching successful text", () => {
  const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
  expect(toolFailure({ ...text("denied"), isError: true })).toBe("denied");
  expect(toolFailure({ diagnostics: [{ severity: "error", message: "Tool unavailable" }] })).toBe(
    "Tool unavailable",
  );

  for (const value of [
    { ok: false, message: "Denied" },
    { error: "No repo" },
    { exitCode: 1, stderr: "Build failed" },
  ])
    expect(toolFailure(text(JSON.stringify(value)))).toBeTruthy();

  for (const value of ["error handling documentation", '{"exitCode":0}', '{"ok":true}', "not JSON"])
    expect(toolFailure(text(value))).toBeUndefined();
});

async function credentials() {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "private-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
}

async function entries() {
  return runInDurableObject(env.AGENT.getByName("owner"), async (_, state) =>
    new Papercuts(state.storage.sql).list(),
  );
}

it("adds papercuts to existing sessions without replacing their other tool configuration", async () => {
  await credentials();
  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;
    await agent["harness"].commit(
      (tx) => configure(tx, conversationId, { tools: [] }),
      BACKGROUND_CONTEXT,
    );
    await state.storage.delete("migration:papercuts-tools");
  });
  await abortAllDurableObjects();
  await SELF.fetch(`https://worker/api/sessions/${id}`, { headers });
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;
    const conversation = (await agent["harness"].conversation(conversationId, BACKGROUND_CONTEXT))!;
    expect((await conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name)).toEqual([
      "papercuts",
    ]);
    expect(await state.storage.get("migration:papercuts-tools")).toBe(true);
  });
});

async function start() {
  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();

  const submitted = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Fix papercuts", requestId: crypto.randomUUID() }),
  });

  expect(submitted.status).toBe(202);

  return id;
}

it("logs model failures automatically with secrets redacted", async () => {
  await credentials();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "Model unavailable private-refresh" } }, { status: 400 }),
  );
  await start();
  await expect.poll(async () => (await entries()).some((row) => row.source === "model")).toBe(true);
  expect(JSON.stringify(await entries())).toContain("Model unavailable");
  expect(JSON.stringify(await entries())).not.toContain("private-refresh");
});

it("registers the papercuts tool and captures failed tool results through the real harness", async () => {
  await credentials();
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const index = requests++;

    const item =
      index < 2
        ? {
            type: "function_call",
            id: `fc_${index}`,
            call_id: `call_${index}`,
            name: index === 0 ? "papercuts" : "workspace",
            arguments: JSON.stringify(
              index === 0
                ? { action: "log", message: "Setup instructions omit private-refresh" }
                : { action: "status" },
            ),
          }
        : {
            type: "message",
            id: "msg_done",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          };

    const events = [
      {
        type: "response.created",
        response: { id: `resp_${index}`, status: "in_progress", output: [] },
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: `resp_${index}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        },
      },
    ];

    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  await start();
  await expect.poll(async () => (await entries()).length).toBe(2);
  const rows = await entries();
  expect(rows.find((row) => row.source === "agent")?.message).toBe(
    "Setup instructions omit [redacted]",
  );
  expect(rows.find((row) => row.source === "tool:workspace")?.message).toContain(
    "Select a repository",
  );
  expect(rows.every((row) => row.conversation_id !== null)).toBe(true);
});
