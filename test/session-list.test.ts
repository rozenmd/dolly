import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SessionIndex } from "../src/coordination";
import { ConversationWorkspace, workspaceConfig } from "../src/workspace";
import type { SavedSession } from "../src/session-contracts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { headers, signIn } from "./session";

beforeEach(async () => {
  await reset();
  await signIn();
});

afterEach(() => vi.restoreAllMocks());

async function list() {
  const response = await SELF.fetch("https://worker/api/sessions", { headers });
  expect(response.status).toBe(200);

  return response.json<SavedSession[]>();
}

async function seed() {
  return runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const harness = agent["harness"];

    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );

    await state.storage.put("session:legacy-id", conversation.id);
    await harness.commit(async (tx) => {
      const workspace = await tx.doc(ConversationWorkspace, conversation.id);
      workspace.config = workspaceConfig(
        { repository: "octocat/project", ref: "main" },
        String(conversation.id),
      );
      // Simulate a deployment predating the coordination index.
      (await tx.doc(SessionIndex)).ids = {};
      await tx.appendEntry(conversation.id, {
        kind: "pi.input",
        model: [{ role: "user", content: "Fix mobile discovery\nMore details", timestamp: 100 }],
      });

      for (let i = 0; i < 60; i++) {
        await tx.appendEntry(conversation.id, {
          kind: "pi.input",
          model: [{ role: "user", content: "Later task", timestamp: 200 + i }],
        });
      }
    }, BACKGROUND_CONTEXT);

    return String(conversation.id);
  });
}

it("discovers legacy sessions without browser storage and retains their public IDs after restart", async () => {
  await seed();

  const expected = [
    {
      id: "legacy-id",
      // Sessions from before workspaces were recorded are workspaces of their own.
      workspaceId: "legacy-id",
      title: "Fix mobile discovery",
      model: "gpt-6-luna",
      thinkingLevel: "medium",
      repository: "octocat/project",
      ref: "main",
      updatedAt: 259,
      archived: false,
      running: false,
    },
  ];

  expect(await list()).toEqual(expected);
  await abortAllDurableObjects();
  expect(await list()).toEqual(expected);
});

it("paginates historical conversations and includes sessions without browser aliases", async () => {
  const ids = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const ids: string[] = [];

    for (let i = 0; i < 101; i++) {
      const conversation = await agent["harness"].createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );

      ids.push(String(conversation.id));
    }

    await agent["harness"].commit(async (tx) => {
      (await tx.doc(SessionIndex)).ids = {};
    }, BACKGROUND_CONTEXT);

    return ids;
  });

  const sessions = await list();
  expect(sessions).toHaveLength(101);
  expect(new Set(sessions.map((session) => session.id))).toEqual(new Set(ids));
  expect((await SELF.fetch(`https://worker/api/sessions/${ids[0]}`, { headers })).status).toBe(200);
});

it("reuses saved transcript summaries for 35 active and 85 archived sessions after restart", async () => {
  const firstId = await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const harness = agent["harness"];
    const ids: ConversationId[] = [];

    await harness.commit(async (tx) => {
      for (let i = 0; i < 120; i++) {
        const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
        ids.push(id);
        await tx.appendEntry(id, {
          kind: "pi.input",
          model: [{ role: "user", content: `Session ${i}`, timestamp: 100 + i }],
        });
      }
    }, BACKGROUND_CONTEXT);

    for (const id of ids.slice(35))
      await state.storage.put(`session-meta:${id}`, { archived: true });

    return ids[0]!;
  });

  const initial = await list();
  expect(initial).toHaveLength(120);
  expect(initial.filter((session) => session.archived)).toHaveLength(85);
  await abortAllDurableObjects();

  // Count full transcript-page reads, not the lightweight tip check used for invalidation.
  const entries = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const conversation = await agent["harness"].conversation(firstId, BACKGROUND_CONTEXT);

    const prototype: Pick<NonNullable<typeof conversation>, "entries"> = Object.getPrototypeOf(
      conversation!,
    );

    return vi.spyOn(prototype, "entries");
  });

  expect(await list()).toEqual(initial);
  expect(entries).not.toHaveBeenCalled();

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    await agent["harness"].commit(async (tx) => {
      await tx.appendEntry(firstId, {
        kind: "pi.input",
        model: [{ role: "user", content: "Follow-up prompt", timestamp: 500 }],
      });
    }, BACKGROUND_CONTEXT);
  });

  expect((await list())[0]).toMatchObject({
    id: String(firstId),
    title: "Session 0",
    updatedAt: 500,
  });
  expect(entries).toHaveBeenCalledTimes(1);
});

it("redacts cached titles again when credentials change", async () => {
  const key = "fixture-opaque-credential";

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const harness = agent["harness"];

    await harness.commit(async (tx) => {
      const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await tx.appendEntry(id, {
        kind: "pi.input",
        model: [{ role: "user", content: `Check ${key}`, timestamp: 100 }],
      });
    }, BACKGROUND_CONTEXT);
  });

  // Connecting a subscription also creates the chief of staff (chief.ts); it is not this session.
  const titled = async () => (await list()).find((session) => !session.chief)?.title;

  expect(await titled()).toBe(`Check ${key}`);
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:anthropic", { type: "api_key", key });
  });
  expect(await titled()).toBe("Check [redacted]");
});

it("persists archive choices across restarts and rejects the retired browser import", async () => {
  await seed();

  const update = (archived: boolean) =>
    SELF.fetch("https://worker/api/sessions/legacy-id", {
      method: "PUT",
      headers,
      body: JSON.stringify({ archived }),
    });

  expect((await update(true)).status).toBe(200);
  await abortAllDurableObjects();
  expect((await list())[0].archived).toBe(true);

  expect((await update(false)).status).toBe(200);

  const retired = await SELF.fetch("https://worker/api/sessions/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessions: [{ ...(await list())[0], archived: true }] }),
  });

  expect(retired.status).toBe(404);
  await abortAllDurableObjects();
  expect((await list())[0].archived).toBe(false);
  expect(
    (
      await SELF.fetch("https://worker/api/sessions/missing", {
        method: "PUT",
        headers,
        body: JSON.stringify({ archived: true }),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await SELF.fetch("https://worker/api/sessions/legacy-id", {
        method: "PUT",
        headers,
        body: JSON.stringify({ archived: "yes" }),
      })
    ).status,
  ).toBe(400);
});

it("pins a workspace across restarts, keeping its pin time when pinned again", async () => {
  await seed();

  // Strings are allowed only to prove the API rejects them.
  const update = (body: { pinned?: boolean | string; archived?: boolean | string }) =>
    SELF.fetch("https://worker/api/sessions/legacy-id", {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

  expect((await list())[0].pinnedAt).toBeUndefined();

  const pinned = await update({ pinned: true });
  expect(pinned.status).toBe(200);
  const { pinnedAt } = await pinned.json<{ pinnedAt: number }>();
  expect(pinnedAt).toBeGreaterThan(0);
  await abortAllDurableObjects();
  expect((await list())[0].pinnedAt).toBe(pinnedAt);

  // Pinning again, or archiving and restoring, leaves the workspace where it was in Pinned.
  expect((await update({ pinned: true })).status).toBe(200);
  expect((await update({ archived: true })).status).toBe(200);
  expect((await update({ archived: false })).status).toBe(200);
  await abortAllDurableObjects();

  const [session] = await list();
  expect(session.pinnedAt).toBe(pinnedAt);
  expect(session.archived).toBe(false);

  const unpinned = await update({ pinned: false });
  expect(await unpinned.json()).toEqual({ pinned: false });
  await abortAllDurableObjects();
  expect((await list())[0].pinnedAt).toBeUndefined();
  expect((await update({ pinned: "yes" })).status).toBe(400);
  expect((await update({})).status).toBe(400);

  // A malformed field fails the whole update instead of applying only the valid pin.
  expect((await update({ archived: "yes", pinned: true })).status).toBe(400);
  expect((await list())[0].pinnedAt).toBeUndefined();
});

it("reports a pull request opened deep in the transcript and remembers it after restart", async () => {
  await seed();

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversation = await state.storage.get<ConversationId>("session:legacy-id");
    expect(conversation).toBeDefined();

    await agent["harness"].commit(async (tx) => {
      await tx.appendEntry(conversation!, {
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "workspace",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  result: {
                    kind: "pull_request",
                    number: 42,
                    url: "https://github.com/octocat/project/pull/42",
                  },
                }),
              },
            ],
            isError: false,
            timestamp: 300,
          },
        ],
      });

      // Push the result outside the newest page.
      for (let i = 0; i < 80; i++) {
        await tx.appendEntry(conversation!, {
          kind: "pi.input",
          model: [{ role: "user", content: "Follow-up", timestamp: 400 + i }],
        });
      }
    }, BACKGROUND_CONTEXT);
  });

  const pullRequest = {
    repository: "octocat/project",
    number: 42,
    url: "https://github.com/octocat/project/pull/42",
  };

  // GitHub is not connected in tests, so state is unknown rather than an error.
  expect((await list())[0].pullRequest).toEqual(pullRequest);
  await abortAllDurableObjects();
  expect((await list())[0].pullRequest).toEqual(pullRequest);
});

it("marks sessions with an in-flight agent turn as running", async () => {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });

  let release!: () => void;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const model = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await blocked;

    return Response.json({ error: { message: "Model unavailable" } }, { status: 400 });
  });

  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();
  const idle = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const other = (await idle.json<{ id: string }>()).id;

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Work on this", requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);
  await expect.poll(() => model.mock.calls.length).toBeGreaterThan(0);

  const running = await list();
  expect(running.find((session) => session.id === id)?.running).toBe(true);
  expect(running.find((session) => session.id === other)?.running).toBe(false);

  release();
  await expect
    .poll(async () => (await list()).find((session) => session.id === id)?.running)
    .toBe(false);
});

/** Arguments of the calls this file's model fake makes. */
type CallArguments = { prompt?: string; in_minutes?: number; url?: string };

type Call = { id: string; name: string; input: CallArguments };

const callItem = ({ id, name, input }: Call) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name,
  arguments: JSON.stringify(input),
});

/** One Responses API stream event: its type and that type's fields. */
type StreamEvent = {
  type: string;
  output_index?: number;
  item?: ReturnType<typeof callItem>;
  delta?: string;
  arguments?: string;
  response?: {
    id: string;
    status: string;
    output: ReturnType<typeof callItem>[];
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  };
};

const sseEvent = (event: StreamEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const created = {
  type: "response.created",
  response: { id: "resp_test", status: "in_progress", output: [] },
};

function completed(output: ReturnType<typeof callItem>[]) {
  return {
    type: "response.completed",
    response: {
      id: "resp_test",
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    },
  };
}

/** A Codex model response of one or more function calls, as the ChatGPT backend streams it. */
function functionCalls(...calls: Call[]) {
  const items = calls.map(callItem);

  const events = [
    created,
    ...items.map((item, index) => ({
      type: "response.output_item.done",
      output_index: index,
      item,
    })),
    completed(items),
  ];

  return new Response(events.map(sseEvent).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * A response that starts streaming one call once `start` settles, holds it half written, and
 * finishes it once `finish` settles: the step is in the live doc before any tool task exists.
 */
function streamedCall(call: Call, start: Promise<void>, finish: Promise<void>) {
  const item = callItem(call);
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(sseEvent(event)));
      send(created);
      await start;
      send({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "" },
      });
      send({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: item.arguments.slice(0, -2),
      });
      await finish;
      send({
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: item.arguments,
      });
      send({ type: "response.output_item.done", output_index: 0, item });
      send(completed([item]));
      controller.close();
    },
  });

  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function connectOpenAI(refresh: string) {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh,
      expires: Date.now() + 3_600_000,
    });
  });
}

/** An open sidebar socket, counting the "refetch the list" messages it gets. */
async function openFeed() {
  const response = await SELF.fetch("https://worker/api/events", {
    headers: { ...headers, Upgrade: "websocket", Origin: "https://worker" },
  });

  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const feed = { announced: 0, close: () => socket.close() };

  socket.addEventListener("message", (event) => {
    expect(event.data).toBe(JSON.stringify({ type: "sessions" }));
    feed.announced += 1;
  });
  socket.accept();

  return feed;
}

async function startSession(content: string) {
  const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await response.json<{ id: string }>();

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);

  return id;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("says what a running session is doing, redacted, and tells open sidebars when it moves", async () => {
  const refresh = "fixture-refresh-credential";
  const page = "https://docs.example.com/rollout";
  await connectOpenAI(refresh);

  let startStreaming!: () => void;
  let finishStreaming!: () => void;
  let servePage!: () => void;
  const streaming = new Promise<void>((resolve) => (startStreaming = resolve));
  const streamed = new Promise<void>((resolve) => (finishStreaming = resolve));
  const served = new Promise<void>((resolve) => (servePage = resolve));
  let asked = 0;
  let fetching = false;

  // The model asks for a schedule_prompt call, then streams a web_fetch call that the test holds
  // half written, of a page the test holds open, then fails, which ends the run.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);

    if (request.url === page) {
      fetching = true;
      await served;

      return new Response("Rolled out.", { headers: { "content-type": "text/plain" } });
    }

    const body = await request.text();
    asked += 1;

    if (body.includes("call_second"))
      return Response.json({ error: { message: "Model unavailable" } }, { status: 400 });

    if (body.includes("call_first"))
      return streamedCall(
        { id: "second", name: "web_fetch", input: { url: page } },
        streaming,
        streamed,
      );

    return functionCalls({
      id: "first",
      name: "schedule_prompt",
      input: { prompt: `Deploy with ${refresh}`, in_minutes: 60 },
    });
  });

  const feed = await openFeed();
  const id = await startSession("Ship it");
  const session = async () => (await list()).find((item) => item.id === id);

  try {
    // The tool call's arguments are redacted before they are summarised, like titles.
    await expect
      .poll(async () => (await session())?.activity)
      .toBe("schedule_prompt in 1h · Deploy with [redacted]");
    expect(await session()).toMatchObject({ running: true });

    // The next generation is waiting on the model: its start has been announced already, and
    // nothing else the list shows changes until the model streams the next call.
    await expect.poll(() => asked).toBe(2);
    await pause(500);
    const before = feed.announced;
    startStreaming();

    // A call still streaming is announced from the live doc, before any tool task exists.
    await expect.poll(() => feed.announced, { timeout: 5_000 }).toBeGreaterThan(before);
    expect(await session()).toMatchObject({ running: true, activity: "Reading the web" });
    expect(fetching).toBe(false);

    finishStreaming();
    await expect.poll(() => fetching).toBe(true);

    // Unchanged activity is not announced again.
    const settled = feed.announced;
    await pause(2_500);
    expect(feed.announced).toBe(settled);
    expect(await session()).toMatchObject({ running: true, activity: "Reading the web" });

    servePage();
    await expect.poll(async () => (await session())?.running).toBe(false);
    // Only running sessions say what they are doing.
    expect((await session())?.activity).toBeUndefined();
  } finally {
    startStreaming();
    finishStreaming();
    servePage();
    feed.close();
  }
}, 30_000);

it("keeps a round's running call in reach and folds several sessions' moves into one announcement", async () => {
  await connectOpenAI("fixture-refresh-credential");

  let release!: () => void;
  let servePages!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const served = new Promise<void>((resolve) => (servePages = resolve));
  const tags = ["alpha", "beta", "gamma"];
  const waiting = new Set<string>();
  const fetching = new Set<string>();

  // Each session asks for five calls in one round, waits on the model until the test releases
  // it, then fetches a page the test holds open, then fails, which ends its run.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const page = /^https:\/\/docs\.example\.com\/(\w+)$/.exec(request.url);

    if (page?.[1]) {
      fetching.add(page[1]);
      await served;

      return new Response("Done.", { headers: { "content-type": "text/plain" } });
    }

    const body = await request.text();
    const tag = tags.find((candidate) => body.includes(`Task ${candidate}`)) ?? "";

    if (body.includes(`call_${tag}_fetch`))
      return Response.json({ error: { message: "Model unavailable" } }, { status: 400 });

    if (body.includes(`call_${tag}_5`)) {
      waiting.add(tag);
      await released;

      return functionCalls({
        id: `${tag}_fetch`,
        name: "web_fetch",
        input: { url: `https://docs.example.com/${tag}` },
      });
    }

    return functionCalls(
      ...[1, 2, 3, 4, 5].map((hours) => ({
        id: `${tag}_${hours}`,
        name: "schedule_prompt",
        input: { prompt: `${tag} ${hours}`, in_minutes: hours * 60 },
      })),
    );
  });

  const feed = await openFeed();
  const ids = await Promise.all(tags.map((tag) => startSession(`Task ${tag}`)));

  const activities = async () => {
    const sessions = await list();

    return ids.map((id) => sessions.find((session) => session.id === id)?.activity);
  };

  try {
    // Five results landed after the round's assistant entry; its last call is still found.
    await expect.poll(() => waiting.size).toBe(3);
    expect(await activities()).toEqual(tags.map((tag) => `schedule_prompt in 5h · ${tag} 5`));

    await pause(2_500);
    const before = feed.announced;
    release();

    // Three sessions move at once: one feed-wide announcement, then quiet.
    await expect.poll(() => fetching.size).toBe(3);
    await expect.poll(() => feed.announced, { timeout: 5_000 }).toBeGreaterThan(before);
    await pause(2_500);
    expect(feed.announced - before).toBeLessThanOrEqual(2);
    expect(await activities()).toEqual(tags.map(() => "Reading the web"));

    servePages();
    await expect.poll(async () => (await list()).every((session) => !session.running)).toBe(true);
  } finally {
    release();
    servePages();
    feed.close();
  }
}, 30_000);
