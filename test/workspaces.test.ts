import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ConversationWorkspace, workspaceConfig } from "../src/workspace";
import type { SavedSession } from "../src/session-contracts";
import { headers, signIn } from "./session";

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
  // No model call in these tests should succeed; spawned children just fail their turn.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: { message: "Model unavailable" } }, { status: 400 }),
  );
});

afterEach(() => vi.restoreAllMocks());

const create = (body: {
  workspace?: { repository: string; ref?: string; branch?: string };
  workspaceId?: string;
}) =>
  SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

async function list() {
  const response = await SELF.fetch("https://worker/api/sessions", { headers });
  expect(response.status).toBe(200);

  return response.json<SavedSession[]>();
}

/** The repository selection Pi holds for a session. */
function selection(id: string) {
  return runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = await state.storage.get<ConversationId>(`session:${id}`);

    if (!conversationId) throw new Error("Session missing");

    const doc = await agent["harness"].snapshot(
      ConversationWorkspace,
      conversationId,
      BACKGROUND_CONTEXT,
    );

    return { conversationId: String(conversationId), config: doc?.config };
  });
}

it("starts each new session in a new workspace and lets later sessions join it", async () => {
  const first = await create({ workspace: { repository: "octocat/project", ref: "main" } });
  expect(first.status).toBe(201);
  const a = await first.json<{ id: string; workspaceId: string }>();
  expect(a.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.workspaceId).not.toBe(a.id);

  // Joining inherits the workspace's repository, on a branch of its own.
  const second = await create({ workspaceId: a.workspaceId });
  expect(second.status).toBe(201);
  const b = await second.json<{ id: string; workspaceId: string }>();
  expect(b.workspaceId).toBe(a.workspaceId);
  const joined = await selection(b.id);
  expect(joined.config).toMatchObject({
    repository: "octocat/project",
    ref: "main",
    branch: `dolly/session-${joined.conversationId}`,
  });

  // A session started on its own gets a workspace of its own.
  const other = await (await create({})).json<{ id: string; workspaceId: string }>();
  expect(other.workspaceId).not.toBe(a.workspaceId);

  const sessions = await list();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  expect(byId.get(a.id)?.workspaceId).toBe(a.workspaceId);
  expect(byId.get(b.id)?.workspaceId).toBe(a.workspaceId);
  expect(byId.get(other.id)?.workspaceId).toBe(other.workspaceId);
  expect(byId.get(a.id)?.createdAt).toEqual(expect.any(Number));

  // Spawned sessions belong to their parent's workspace.
  const spawned = await SELF.fetch(`https://worker/api/sessions/${a.id}/children`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Investigate the flaky test", requestId: crypto.randomUUID() }),
  });

  expect(spawned.status).toBe(202);
  const child = await spawned.json<{ id: string }>();
  const listed = (await list()).find((session) => session.id === child.id);
  expect(listed).toMatchObject({ parentId: a.id, workspaceId: a.workspaceId });

  // Spawned sessions do not name workspaces, and unknown workspaces are refused.
  for (const workspaceId of [child.id, "missing"]) {
    const refused = await create({ workspaceId });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Workspace not found" });
  }
});

it("treats a session from before workspaces as a workspace keyed by its own ID", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const harness = agent["harness"];

    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );

    await state.storage.put("session:legacy-id", conversation.id);
    await harness.commit(async (tx) => {
      const workspace = await tx.doc(ConversationWorkspace, conversation.id);
      workspace.config = workspaceConfig(
        { repository: "octocat/legacy", ref: "trunk" },
        String(conversation.id),
      );
      await tx.appendEntry(conversation.id, {
        kind: "pi.input",
        model: [{ role: "user", content: "Old work", timestamp: 100 }],
      });
    }, BACKGROUND_CONTEXT);
  });

  expect((await list()).find((session) => session.id === "legacy-id")?.workspaceId).toBe(
    "legacy-id",
  );

  const joined = await create({ workspaceId: "legacy-id" });
  expect(joined.status).toBe(201);
  const session = await joined.json<{ id: string; workspaceId: string }>();
  expect(session.workspaceId).toBe("legacy-id");
  expect((await selection(session.id)).config).toMatchObject({
    repository: "octocat/legacy",
    ref: "trunk",
  });
});

it("pushes a session to the branch a person chose without passing it on to joined sessions", async () => {
  const started = await create({
    workspace: { repository: "octocat/project", branch: "investigate-audit-headers-null" },
  });

  expect(started.status).toBe(201);
  const a = await started.json<{ id: string; workspaceId: string }>();
  const chosen = await selection(a.id);
  expect(chosen.config).toMatchObject({
    repository: "octocat/project",
    ref: "investigate-audit-headers-null",
    branch: "investigate-audit-headers-null",
  });

  // Joining the workspace inherits the checkout, not the push branch.
  const joined = await (await create({ workspaceId: a.workspaceId })).json<{ id: string }>();
  const inherited = await selection(joined.id);
  expect(inherited.config?.branch).toBe(`dolly/session-${inherited.conversationId}`);

  for (const branch of ["refs/heads/main", "-f", "a..b", "trailing/", "x.lock", "has space"])
    expect((await create({ workspace: { repository: "octocat/project", branch } })).status).toBe(
      400,
    );
});
