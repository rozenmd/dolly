import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SavedSession } from "../src/session-contracts";
import { sessionMetadataKey, type SessionMetadata } from "../src/model-defaults";
import { AutomationRunDoc } from "../src/automations";
import { ConversationWorkspace, workspaceConfig } from "../src/workspace";
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

/** Claude answers each turn with `reply`; title requests are counted and get `title`. */
function titledModel(title: () => Response) {
  const titleRequests: ClaudeRequest[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);

    if (!request.url.includes("/v1/messages")) return new Response("{}");

    const body = await request.json<ClaudeRequest>();

    if (text(body).includes("short title")) {
      titleRequests.push(body);

      return title();
    }

    return claude({ text: "Done" });
  });

  return titleRequests;
}

async function connectClaude() {
  const saved = await SELF.fetch("https://worker/api/auth/anthropic", {
    method: "PUT",
    headers,
    body: JSON.stringify({ token }),
  });

  expect(saved.status).toBe(200);
}

async function newSession() {
  const created = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-sonnet-5-5" }),
  });

  return (await created.json<{ id: string }>()).id;
}

/**
 * Send a prompt and wait for its run to end: the status line (session-status.ts) is saved in the
 * same afterRun hook that starts the automatic title, so a new `status.at` marks the hook ran.
 */
async function runOnce(id: string, content: string) {
  const before = (await sessions()).find((session) => session.id === id)?.status?.at;

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);
  await expect
    .poll(
      async () => {
        const session = (await sessions()).find((session) => session.id === id);

        return !session?.running && session?.status !== undefined && session.status.at !== before;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Let the afterRun hook's background title attempt make its request, if it is going to. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

async function conversationOf(id: string, storage: DurableObjectStorage) {
  return (await storage.get<ConversationId>(`session:${id}`))!;
}

it("titles a new session after its first run, and only after its first", async () => {
  const titleRequests = titledModel(() => claude({ text: "Plan the billing migration" }));

  await connectClaude();
  const id = await newSession();
  await runOnce(id, "Work out how to move billing to the new provider\nWith a rollback plan");

  await expect
    .poll(async () => (await sessions()).find((session) => session.id === id)?.title, {
      timeout: 10_000,
    })
    .toBe("Plan the billing migration");
  expect(titleRequests).toHaveLength(1);
  expect(titleRequests[0]?.model).toBe("claude-haiku-5-5");
  expect(text(titleRequests[0]!)).toContain("Work out how to move billing");

  await runOnce(id, "Now write the rollback plan");
  await settle();

  expect(titleRequests).toHaveLength(1);
  expect((await sessions()).find((session) => session.id === id)?.title).toBe(
    "Plan the billing migration",
  );
});

it("tries the automatic title once, keeping the first line when generation fails", async () => {
  const titleRequests = titledModel(() =>
    Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "No titles today" } },
      { status: 400 },
    ),
  );

  await connectClaude();
  const id = await newSession();
  await runOnce(id, "Fix the flaky checkout test\nIt fails one run in ten");
  await expect.poll(() => titleRequests.length, { timeout: 10_000 }).toBe(1);
  await settle();

  expect((await sessions()).find((session) => session.id === id)?.title).toBe(
    "Fix the flaky checkout test",
  );

  // The failure isn't retried on later runs: one cheap call per session, at most.
  await runOnce(id, "Try again");
  await settle();

  expect(titleRequests).toHaveLength(1);
  expect((await sessions()).find((session) => session.id === id)?.title).toBe(
    "Fix the flaky checkout test",
  );
});

it("leaves titled sessions, automatic reviews and automation runs to their own titles", async () => {
  const titleRequests = titledModel(() => claude({ text: "Should not be used" }));

  await connectClaude();
  const titled = await newSession();
  const review = await newSession();
  const nightly = await newSession();

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const titledId = await conversationOf(titled, state.storage);
    const reviewId = await conversationOf(review, state.storage);
    const nightlyId = await conversationOf(nightly, state.storage);

    // Named already, as retitle_session does.
    await state.storage.put(sessionMetadataKey(titledId), {
      ...(await state.storage.get<SessionMetadata>(sessionMetadataKey(titledId))),
      title: "Named by hand",
    });

    // As github-inbox.ts admits an automatic review and automations.ts starts a run.
    await agent["harness"].commit(async (tx) => {
      (await tx.doc(ConversationWorkspace, reviewId)).config = workspaceConfig(
        { repository: "octo/app", ref: "refs/pull/12/head" },
        String(reviewId),
        { readOnly: true },
      );
      (await tx.doc(AutomationRunDoc, nightlyId)).run = {
        automationId: "nightly",
        name: "Nightly dependency check",
        trigger: "schedule",
        mcpServers: [],
      };
    }, BACKGROUND_CONTEXT);
  });

  await runOnce(titled, "Something else entirely");
  await runOnce(review, "Review this pull request");
  await runOnce(nightly, "Check the dependencies");
  await settle();

  expect(titleRequests).toHaveLength(0);

  const listed = await sessions();
  expect(listed.find((session) => session.id === titled)?.title).toBe("Named by hand");
  expect(listed.find((session) => session.id === nightly)?.title).toBe("Check the dependencies");
});
