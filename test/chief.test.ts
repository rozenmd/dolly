import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SavedSession } from "../src/session-contracts";
import { CHIEF_KEY, CHIEF_NAME_KEY, type ChiefRecord } from "../src/chief";
import { sessionMetadataKey } from "../src/model-defaults";
import { headers, signIn } from "./session";
import { mockFetch } from "./titles";

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

type CodexOutput =
  | {
      type: "message";
      id: string;
      role: "assistant";
      status: "completed";
      content: { type: "output_text"; text: string; annotations: never[] }[];
    }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string };

function sse(item: CodexOutput) {
  const events = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
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
}

const answer = (text = "Done") =>
  sse({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });

const toolCall = (name: string, args: Record<string, string>) =>
  sse({
    type: "function_call",
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
  });

const owner = () => env.AGENT.getByName("owner");

async function connectChatGPT() {
  await runInDurableObject(owner(), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
}

beforeEach(async () => {
  await reset();
  await signIn();
  await connectChatGPT();
  // Earlier tests' conversations stay behind as ordinary sessions; start without a chief.
  await runInDurableObject(owner(), async (_, state) => {
    await state.storage.delete([CHIEF_KEY, CHIEF_NAME_KEY]);
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

async function list() {
  const response = await SELF.fetch("https://worker/api/sessions", { headers });
  expect(response.status).toBe(200);

  return response.json<SavedSession[]>();
}

const chiefOf = (sessions: readonly SavedSession[]) =>
  sessions.filter((session) => session.chief === true);

async function createSession() {
  const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  expect(response.status).toBe(201);

  return (await response.json<{ id: string }>()).id;
}

/** Names are sent as given, including the non-strings the endpoint must refuse. */
const rename = (name: string | number | null) =>
  SELF.fetch("https://worker/api/settings/chief", {
    method: "PUT",
    headers,
    body: JSON.stringify({ name }),
  });

const archive = (id: string, archived: boolean) =>
  SELF.fetch(`https://worker/api/sessions/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ archived }),
  });

async function send(id: string, content: string) {
  const response = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: crypto.randomUUID() }),
  });

  expect(response.status).toBeLessThan(300);
}

/** Capture every model request body and answer with the given responses, then plain answers. */
function mockModel(responses: (() => Response)[] = []) {
  const bodies: string[] = [];

  mockFetch(async (_, init) => {
    bodies.push(
      new TextDecoder().decode(new Uint8Array(await new Response(init?.body).arrayBuffer())),
    );

    return (responses.shift() ?? answer)();
  });

  return bodies;
}

async function disconnectChatGPT() {
  await runInDurableObject(owner(), async (_, state) => {
    await state.storage.delete("credential:openai");
  });
}

it("creates the chief of staff exactly once, however often and concurrently sessions are listed", async () => {
  // Count the conversations earlier tests left, without creating a chief.
  await disconnectChatGPT();
  const before = (await list()).length;
  await connectChatGPT();

  const lists = await Promise.all(Array.from({ length: 6 }, () => list()));
  const again = await list();

  for (const sessions of [...lists, again]) {
    // One more session: no second chief and no orphaned conversation.
    expect(sessions).toHaveLength(before + 1);
    expect(chiefOf(sessions)).toHaveLength(1);
  }

  const [chief] = chiefOf(again);
  expect(lists.every((sessions) => chiefOf(sessions)[0]?.id === chief?.id)).toBe(true);
  expect(chief).toMatchObject({ title: "Dolly", repository: "", archived: false });

  const record = await runInDurableObject(owner(), async (_, state) =>
    state.storage.get<ChiefRecord>(CHIEF_KEY),
  );

  expect(record?.session).toBe(chief?.id);

  // Other sessions are ordinary work sessions, listed beside it.
  const work = await createSession();
  const sessions = await list();
  expect(chiefOf(sessions).map((session) => session.id)).toEqual([chief?.id]);
  expect(sessions.find((session) => session.id === work)?.chief).toBeUndefined();
});

it("waits for a subscription before creating the chief of staff", async () => {
  await disconnectChatGPT();
  expect(chiefOf(await list())).toEqual([]);

  await connectChatGPT();
  expect(chiefOf(await list())).toHaveLength(1);
});

it("lists the chief under the name set in Settings and validates it", async () => {
  const read = async () =>
    (await SELF.fetch("https://worker/api/settings/chief", { headers })).json<{ name: string }>();

  expect(await read()).toEqual({ name: "Dolly" });

  const renamed = await rename("  Ada  ");
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toEqual({ name: "Ada" });
  expect(await read()).toEqual({ name: "Ada" });
  expect(chiefOf(await list()).map((session) => session.title)).toEqual(["Ada"]);

  for (const name of ["", "   ", "x".repeat(41), "Ada\u0007", "Line\nbreak", 42, null]) {
    const response = await rename(name);
    expect(response.status, JSON.stringify(name)).toBe(400);
  }

  // Forty characters is the limit, counted as characters rather than UTF-16 units.
  expect((await rename("🦊".repeat(40))).status).toBe(200);
  expect(await read()).toEqual({ name: "🦊".repeat(40) });
  await rename("Ada");
  expect(chiefOf(await list()).map((session) => session.title)).toEqual(["Ada"]);
});

it("refuses to archive the chief of staff", async () => {
  const [chief] = chiefOf(await list());
  const refused = await archive(chief!.id, true);

  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "The chief of staff can't be archived" });
  expect(chiefOf(await list())[0]?.archived).toBe(false);

  // Its conversation id is refused too, not only its public id.
  const record = await runInDurableObject(owner(), async (_, state) =>
    state.storage.get<ChiefRecord>(CHIEF_KEY),
  );

  expect((await archive(String(record?.conversation), true)).status).toBe(409);

  // Other sessions still archive.
  const work = await createSession();
  expect((await archive(work, true)).status).toBe(200);
  expect((await list()).find((session) => session.id === work)?.archived).toBe(true);
});

it("briefs the chief with its name and lets it read the owner's sessions", async () => {
  await rename("Ada");
  const [chief] = chiefOf(await list());
  const work = await createSession();
  const bodies = mockModel([() => toolCall("dolly", { action: "list_sessions" })]);

  await send(chief!.id, "Who is working on what?");
  await expect.poll(() => bodies.length).toBe(2);

  expect(bodies[0]).toContain("You are Ada, the owner's chief of staff.");
  expect(bodies[0]).toContain("send_to_session");
  // It doesn't call a pull request ready to merge without checking CI and open threads itself.
  expect(bodies[0]).toContain("Never tell the owner a pull request is ready to merge");
  expect(bodies[0]).toContain("list_pull_request_comments with filter unresolved");
  // A web-app session: the dolly tool lists sessions for it, marking the chief.
  expect(bodies[1]).toContain(String.raw`\"chief\":true`);
  expect(bodies[1]).toContain(work);

  // Other sessions get no briefing.
  await send(work, "Fix the bug");
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).not.toContain("chief of staff");
});

it("follows up on a web session by the id list_sessions reports", async () => {
  const [chief] = chiefOf(await list());
  const work = await createSession();

  const bodies = mockModel([
    () => toolCall("send_to_session", { id: work, message: "Status on the bug?" }),
  ]);

  await send(chief!.id, "Ask the bug session for a status");
  // The chief's request, its tool result, then the work session's turn on the delivered message.
  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(3);

  expect(bodies[1]).not.toContain("No task/session");
  expect(bodies.slice(2).some((body) => body.includes("Status on the bug?"))).toBe(true);
});

it("keeps delegating past the child cap by forgetting settled children", async () => {
  mockFetch(async () => answer());
  const [chief] = chiefOf(await list());

  const children = async () => {
    const response = await SELF.fetch(`https://worker/api/sessions/${chief!.id}/children`, {
      headers,
    });

    return (await response.json<{ children: { id: string; state: string }[] }>()).children;
  };

  const spawned: string[] = [];

  for (let count = 0; count < 40; count++) {
    const response = await SELF.fetch(`https://worker/api/sessions/${chief!.id}/children`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: `Task ${count}`, requestId: crypto.randomUUID() }),
    });

    expect(response.status, `spawn ${count}`).toBe(202);
    spawned.push((await response.json<{ id: string }>()).id);
    await expect
      .poll(async () => (await children()).every((child) => child.state === "idle"), {
        timeout: 4000,
      })
      .toBe(true);
  }

  // The newest children are kept; the earlier, settled ones were forgotten at the cap.
  const kept = (await children()).map((child) => child.id);
  expect(kept.length).toBeLessThanOrEqual(32);
  expect(kept).toContain(spawned.at(-1));
}, 60_000);

it("has no coordinator mode, and ignores the flag in older session metadata", async () => {
  const work = await createSession();

  const configure = await SELF.fetch(`https://worker/api/sessions/${work}/settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ coordinator: true }),
  });

  expect(configure.status).toBe(400);

  // A session switched to coordinator mode before the mode was removed.
  await runInDurableObject(owner(), async (_, state) => {
    const conversation = await state.storage.get<ConversationId>(`session:${work}`);
    const key = sessionMetadataKey(conversation!);
    await state.storage.put(key, { ...(await state.storage.get<object>(key)), coordinator: true });
  });

  const sessions = await list();
  const listed = sessions.find((session) => session.id === work);
  expect(listed).toBeDefined();
  expect(listed).not.toHaveProperty("coordinator");
  expect(listed?.chief).toBeUndefined();

  const bodies = mockModel();
  await send(work, "Plan it");
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).not.toContain("Coordinator mode is on");
  expect(bodies[0]).not.toContain("chief of staff");
});
