import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import {
  PAGE_BYTES,
  Papercuts,
  SIGNATURE_VERSION,
  papercutSignature,
  toolFailure,
} from "../src/papercuts";
import { STEER_TOOL_SKIP } from "../src/steer-interrupt";
import {
  CHECKPOINT_TIMEOUT_MS,
  checkpointTimeoutMessage,
  ConversationWorkspace,
  workspaceConfig,
} from "../src/workspace";
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
    expect(store.list().entries).toHaveLength(3);
    expect(store.list({ repository: "ORG/REPO" }).entries).toHaveLength(2);
    expect(() => store.log({ kind: "improvement", source: "agent", message: "  " })).toThrow(
      "empty",
    );
    expect(store.resolve({ id: first.id })).toEqual({ resolved: 1 });
    expect(store.resolve({ id: first.id })).toEqual({ resolved: 0 });
    expect(store.resolve({ id: "missing" })).toEqual({ resolved: 0 });
    expect(store.list({ repository: "org/repo" }).entries).toHaveLength(1);
    expect(store.list({ repository: "org/repo", status: "fixed" }).entries[0]).toMatchObject({
      id: first.id,
      resolution_reason: "fixed",
    });

    return first.id;
  });

  await abortAllDurableObjects();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);
    expect(store.list().entries).toHaveLength(2);
    expect(store.list({ status: "fixed" }).entries[0].id).toBe(id);
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
    { exitCode: 2, stdout: "", stderr: "" },
    { exitCode: 124, timedOut: true, stdout: "", stderr: "" },
  ])
    expect(toolFailure(text(JSON.stringify(value)))).toBeTruthy();

  for (const value of [
    "error handling documentation",
    '{"exitCode":0}',
    '{"ok":true}',
    "not JSON",
    // grep/diff/test answering "no": exit 1 with nothing on stderr is not a failure.
    '{"stdout":"","stderr":"  \\n","exitCode":1}',
  ])
    expect(toolFailure(text(value))).toBeUndefined();

  // Exit 1 with output on stdout only: "no" from grep/diff/test, a real failure from anything else.
  const quiet = (stdout: string) => text(JSON.stringify({ stdout, stderr: "", exitCode: 1 }));
  const diff = quiet("--- a\n+++ b\n-old\n+new");

  for (const command of [
    "diff -u a b",
    "cd web && git diff --exit-code",
    "cat log | grep -n warn",
    "test -f out.txt",
  ])
    expect(toolFailure(diff, { arguments: { command } })).toBeUndefined();
  const nodeTest = quiet("not ok 1 - parses input\n  ---\n  error: 'Expected values to be equal'");

  for (const call of [undefined, { arguments: { command: "pnpm test" } }])
    expect(toolFailure(nodeTest, call)).toContain("Expected values to be equal");
});

it("redacts whole fields before clipping them, so a secret at the cutoff leaves no prefix", () => {
  const secret = "rt_".padEnd(60, "s3cr3t");
  const safe = (value: string) => value.split(secret).join("[redacted]");

  const result = {
    output: [
      {
        type: "text" as const,
        text: JSON.stringify({
          stdout: "",
          stderr: `${"e".repeat(480)}${secret} failed`,
          exitCode: 2,
        }),
      },
    ],
  };

  const summary = toolFailure(result, { arguments: { command: `curl -H ${secret}` } }, safe)!;
  expect(summary).not.toContain("rt_s3cr3t");
  expect(summary).toContain("curl -H [redacted]");
  expect(JSON.parse(summary).stderr).toContain("[redacted]");
});

it("stores a compact summary of a shell failure instead of its whole output", () => {
  const huge = "x".repeat(100_000);

  const result = {
    output: [
      {
        type: "text" as const,
        text: JSON.stringify({
          stdout: huge,
          stderr: `sh: 1: rg: not found\n${"y".repeat(5000)}`,
          exitCode: 127,
          workspaceSetup: { state: "ready", log: huge },
        }),
      },
    ],
  };

  const summary = JSON.parse(toolFailure(result, { arguments: { command: "rg foo src" } })!);
  expect(summary).toMatchObject({ exitCode: 127, command: "rg foo src" });
  expect(summary.stderr.startsWith("sh: 1: rg: not found")).toBe(true);
  expect(summary.stderr.length).toBeLessThanOrEqual(501);
  expect(summary).not.toHaveProperty("stdoutTail");
  expect(summary).not.toHaveProperty("workspaceSetup");

  const quiet = JSON.parse(
    toolFailure({
      output: [
        {
          type: "text" as const,
          text: JSON.stringify({ stdout: `${huge}\n3 tests failed`, stderr: "", exitCode: 2 }),
        },
      ],
    })!,
  );

  expect(quiet.stdoutTail.endsWith("3 tests failed")).toBe(true);
  expect(quiet.stdoutTail.length).toBeLessThanOrEqual(301);

  const timeout = JSON.parse(
    toolFailure({
      output: [
        {
          type: "text" as const,
          text: JSON.stringify({ stdout: "", stderr: "", exitCode: 124, timedOut: true }),
        },
      ],
    })!,
  );

  expect(timeout).toEqual({ exitCode: 124, timedOut: true });
});

it("groups checkpoint timeouts by cause, whatever the restore point was", () => {
  const signature = (previous: Parameters<typeof checkpointTimeoutMessage>[1]) =>
    papercutSignature(
      "workspace:checkpoint",
      checkpointTimeoutMessage(CHECKPOINT_TIMEOUT_MS, previous),
    );

  expect(signature(null)).toBe(
    "workspace:checkpoint||workspace save timed out: the container snapshot did not finish within <n> minutes.",
  );
  expect(signature({ id: "snapshot-abc", turnId: "turn-1", savedAt: Date.now() })).toBe(
    signature(null),
  );
  expect(signature({ id: "other" })).toBe(signature(null));
});

it("gives repeats of one failure the same signature and different failures different ones", () => {
  const shell = (stderr: string, exitCode = 127) => JSON.stringify({ exitCode, stderr });
  expect(papercutSignature("tool:shell", shell("sh: 1: rg: not found"))).toBe(
    "tool:shell||command not found: rg",
  );
  expect(
    papercutSignature(
      "tool:shell",
      shell("warning: noisy\nError: ENOENT /workspace/repo/src/a.ts at 2026-11-27T10:00:00Z", 1),
    ),
  ).toBe(
    papercutSignature(
      "tool:shell",
      shell("warning: other\nError: ENOENT /tmp/b/c.ts at 2025-01-01T00:00:00.123Z", 1),
    ),
  );
  expect(
    papercutSignature(
      "tool:workspace",
      JSON.stringify({
        ok: false,
        error: "Commit 3f2a9c1d failed for 7f0c1e9e-1111-4a2b-9c3d-000000000001",
      }),
    ),
  ).toBe("tool:workspace||commit <hash> failed for <id>");
  expect(papercutSignature("model", "529 servers overloaded, retry req_011CXyz123")).toBe(
    "model||<n> servers overloaded, retry <id>",
  );
  // A missing command is one problem whatever the exit code.
  expect(papercutSignature("tool:shell", shell("sh: 1: rg: not found"))).toBe(
    papercutSignature("tool:shell", shell("sh: 1: rg: not found", 1)),
  );
  expect(papercutSignature("tool:shell", shell("sh: 1: rg: not found"))).not.toBe(
    papercutSignature("tool:shell", shell("sh: 1: python: not found")),
  );
});

it("groups clipped legacy entries by what survived the clip, never by their stdout", () => {
  // The old logger stored the whole reply clipped at 4,000 characters.
  const legacy = (stdout: string) =>
    JSON.stringify({ stdout, stderr: "sh: 1: rg: not found\n", exitCode: 127 }).slice(0, 4000);

  expect(papercutSignature("tool:shell", legacy("a".repeat(5000)))).toBe(
    papercutSignature("tool:shell", legacy("b ".repeat(2500))),
  );
  expect(papercutSignature("tool:shell", legacy("a".repeat(5000)))).toBe(
    "tool:shell||truncated tool result",
  );
  expect(papercutSignature("tool:shell", legacy("short\n").padEnd(4100, " "))).toBe(
    "tool:shell||command not found: rg",
  );

  const stderrFirst = JSON.stringify({
    exitCode: 1,
    stderr: `Error: ENOENT ${"z".repeat(5000)}`,
  }).slice(0, 4000);

  expect(papercutSignature("tool:shell", stderrFirst)).toMatch(/^tool:shell\|1\|error: enoent/);
});

it("adds signatures to entries stored before signatures existed", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const sql = state.storage.sql;
    // The Agent already created the current table; put it back in its pre-signature shape.
    new Papercuts(sql);
    sql.exec("DROP INDEX app_papercuts_signature");
    sql.exec("ALTER TABLE app_papercuts DROP COLUMN signature");
    sql.exec(
      "INSERT INTO app_papercuts (id, kind, source, message, created_at) VALUES (?, ?, ?, ?, ?)",
      "old",
      "error",
      "tool:shell",
      JSON.stringify({
        stdout: "x".repeat(10_000),
        stderr: "sh: 1: rg: not found\n",
        exitCode: 127,
      }),
      1,
    );

    const store = new Papercuts(sql);
    expect(store.list().entries).toMatchObject([
      { id: "old", signature: "tool:shell||command not found: rg" },
    ]);
    store.log({ kind: "error", source: "model", message: "Overloaded" });
    expect(new Papercuts(sql).list().entries.map((row) => row.signature)).toEqual([
      "model||overloaded",
      "tool:shell||command not found: rg",
    ]);
  });
});

/** Log an entry as if at `time`, so paging, grouping and cutoffs are deterministic. */
function logAt(
  store: Papercuts,
  time: number,
  input: Partial<Parameters<Papercuts["log"]>[0]> & { message: string },
) {
  vi.spyOn(Date, "now").mockReturnValueOnce(time);

  return store.log({ kind: "error", source: "tool:shell", ...input }).id;
}

it("pages compact entries with a cursor and reads one entry in full", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);
    const long = `Build failed: ${"x".repeat(1_000)}`;

    const ids = Array.from({ length: 5 }, (_, index) =>
      logAt(store, 1_000 + Math.floor(index / 2), {
        message: index === 4 ? long : `Failed ${index}`,
      }),
    );

    const first = store.list({ limit: 2 });
    expect(first).toMatchObject({ total: 5, more: true, nextCursor: expect.any(String) });
    expect(first.entries[0]).toMatchObject({
      id: ids[4],
      message_length: long.length,
      signature: expect.any(String),
      kind: "error",
      source: "tool:shell",
      created_at: 1_002,
    });
    expect(first.entries[0].message).toHaveLength(201);
    expect(first.entries[0]).not.toHaveProperty("resolved_at");

    const seen = [...first.entries];
    let page = first;

    while (page.more) {
      page = store.list({ limit: 2, cursor: page.nextCursor });
      seen.push(...page.entries);
    }

    expect(page).not.toHaveProperty("nextCursor");
    expect(new Set(seen.map((entry) => entry.id))).toEqual(new Set(ids));
    expect(seen).toHaveLength(5);
    expect(store.read(ids[4]).message).toBe(long);
    expect(() => store.read("missing")).toThrow("No papercut");
    expect(store.list({ limit: 10_000 }).entries).toHaveLength(5);
    expect(() => store.list({ cursor: "nonsense" })).toThrow("Invalid cursor");
  });
});

it("groups entries by signature and flags a problem that came back after it was resolved", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);

    const notFound = (port: number) =>
      JSON.stringify({ exitCode: 127, stderr: `sh: ${port}: rg: not found` });

    const fixed = logAt(store, 100, {
      conversationId: "a",
      repository: "org/a",
      message: notFound(1),
    });

    logAt(store, 20_000, { conversationId: "a", repository: "org/a", message: notFound(2) });
    logAt(store, 30_000, { conversationId: "b", repository: "org/b", message: notFound(3) });
    logAt(store, 25_000, { kind: "improvement", source: "agent", message: "Docs are missing" });

    vi.spyOn(Date, "now").mockReturnValueOnce(15_000);
    expect(store.resolve({ id: fixed })).toEqual({ resolved: 1 });

    const { groups, total, more } = store.groups();
    expect({ total, more }).toEqual({ total: 2, more: false });
    expect(groups).toMatchObject([
      {
        signature: "tool:shell||command not found: rg",
        count: 2,
        sessions: 2,
        repositories: ["org/a", "org/b"],
        repository_count: 2,
        first_seen: 20_000,
        last_seen: 30_000,
        sample_message: notFound(3),
        last_resolved_at: 15_000,
        last_resolution_reason: "fixed",
        recurred_after_resolve: true,
      },
      { signature: "agent||docs are missing", count: 1, sessions: 0, repositories: [] },
    ]);
    expect(groups[0].sample_ids).toHaveLength(2);
    expect(groups[1]).not.toHaveProperty("last_resolved_at");

    const page = store.groups({ limit: 1 });
    expect(page).toMatchObject({ more: true, groups: [{ count: 2 }] });
    expect(store.groups({ limit: 1, cursor: page.nextCursor })).toMatchObject({
      more: false,
      groups: [{ signature: "agent||docs are missing" }],
    });
    expect(store.groups({ repository: "org/b" }).groups).toMatchObject([
      { count: 1, repositories: ["org/b"] },
    ]);
    expect(store.groups({ status: "fixed" }).groups).toMatchObject([{ count: 1, first_seen: 100 }]);
  });
});

it("resolves by ids or by signature before a time, keeping later repeats open", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);
    const message = JSON.stringify({ exitCode: 127, stderr: "sh: 1: rg: not found" });
    const signature = papercutSignature("tool:shell", message);
    const before = [100, 200, 300].map((time) => logAt(store, time, { message }));
    const after = logAt(store, 500, { message });
    const others = [logAt(store, 150, { message: "A" }), logAt(store, 160, { message: "B" })];

    expect(
      store.resolve({ signature, before: 400, note: "https://github.com/o/r/pull/178" }),
    ).toEqual({ resolved: 3 });
    expect(store.list({ signature }).entries.map((entry) => entry.id)).toEqual([after]);
    expect(store.read(before[0])).toMatchObject({
      resolution_reason: "fixed",
      resolution_note: "https://github.com/o/r/pull/178",
    });
    expect(store.list({ status: "fixed" }).total).toBe(3);

    expect(
      store.resolve({ ids: [...others, others[0], "missing"], reason: "not-an-error" }),
    ).toEqual({
      resolved: 2,
    });
    expect(store.read(others[1]).resolution_reason).toBe("not-an-error");
    expect(store.resolve({ signature })).toEqual({ resolved: 1 });
    expect(store.list().total).toBe(0);

    expect(() => store.resolve({})).toThrow("needs id");
    expect(() => store.resolve({ id: after, signature })).toThrow("not both");
    expect(() => store.resolve({ id: after, before: 1 })).toThrow(
      "only when resolving by signature",
    );
  });
});

it("stops a page short of its row limit before it outgrows the tool output limit", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);
    // Letters, since signatures replace numbers: each entry gets its own signature.

    const word = (index: number) =>
      String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + (index % 26));

    const stderr = (index: number) => `sh: ${word(index)}: ${"é".repeat(300)} failed`;

    for (let index = 0; index < 201; index++)
      logAt(store, index, {
        conversationId: `session-${index}`,
        repository: `org/repo-${index}`,
        message: JSON.stringify({ exitCode: 1, stderr: stderr(index) }),
      });

    const seen = new Set<string>();
    let page = store.list({ limit: 200 });

    for (;;) {
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(PAGE_BYTES + 1024);
      expect(page.entries.length).toBeGreaterThan(0);

      for (const entry of page.entries) seen.add(entry.id);

      if (!page.more) break;
      expect(page.entries.length).toBeLessThan(200);
      page = store.list({ limit: 200, cursor: page.nextCursor });
    }

    expect(seen.size).toBe(201);

    const groups = store.groups({ limit: 200 });
    expect(new TextEncoder().encode(JSON.stringify(groups)).length).toBeLessThan(PAGE_BYTES + 1024);
    expect(groups).toMatchObject({ total: 201, more: true, nextCursor: expect.any(String) });

    for (let index = 0; index < 12; index++)
      logAt(store, 1_000, { repository: `org/many-${index}`, message: "Many repositories" });
    expect(store.groups({ limit: 1 }).groups[0]).toMatchObject({
      repository_count: 12,
      repositories: expect.arrayContaining(["org/many-0"]),
    });
    expect(store.groups({ limit: 1 }).groups[0].repositories).toHaveLength(10);

    store.resolveStale({ olderThanDays: 0, note: "n".repeat(1_000) });
    const fixed = store.list({ status: "fixed" });
    expect(fixed.more).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(fixed)).length).toBeLessThan(PAGE_BYTES + 1024);
  });
});

it("scopes a resolve by signature to one repository when given", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);
    const a = logAt(store, 100, { repository: "org/a", message: "Permission denied: org/a" });
    const b = logAt(store, 100, { repository: "org/b", message: "Permission denied: org/b" });
    const signature = store.read(a).signature;
    expect(store.read(b).signature).toBe(signature);

    expect(store.resolve({ signature, repository: "ORG/A", before: 200 })).toEqual({ resolved: 1 });
    expect(store.read(a).resolved_at).not.toBeNull();
    expect(store.read(b).resolved_at).toBeNull();
    expect(() => store.resolve({ id: b, repository: "org/b" })).toThrow(
      "repository applies only when resolving by signature",
    );
  });
});

it("resolves open entries older than a number of days as stale, optionally for one repository", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);
    const day = 86_400_000;
    const now = Date.now();
    const legacy = '{"stdout":"' + "x".repeat(50);
    const oldA = logAt(store, now - 10 * day, { repository: "org/a", message: legacy });
    const oldB = logAt(store, now - 10 * day, { repository: "org/b", message: legacy });
    const recent = logAt(store, now - day, { repository: "org/a", message: legacy });
    expect(store.read(oldA).signature).toBe("tool:shell||truncated tool result");

    expect(store.resolveStale({ olderThanDays: 7, repository: "ORG/A" })).toEqual({ resolved: 1 });
    expect(store.read(oldA)).toMatchObject({
      resolution_reason: "stale",
      resolved_at: expect.any(Number),
    });
    expect(store.read(oldB).resolved_at).toBeNull();
    expect(store.resolveStale({ olderThanDays: 7, note: "Legacy clipped entries" })).toEqual({
      resolved: 1,
    });
    expect(store.read(oldB)).toMatchObject({
      resolution_reason: "stale",
      resolution_note: "Legacy clipped entries",
    });
    expect(store.list().entries.map((entry) => entry.id)).toEqual([recent]);
    expect(() => store.resolveStale({ olderThanDays: -1 })).toThrow("non-negative");
  });
});

it("adds resolution columns to existing rows, marking already resolved entries as fixed", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const sql = state.storage.sql;
    // Put the table back in its shape before resolution reasons existed.
    new Papercuts(sql);
    sql.exec("ALTER TABLE app_papercuts DROP COLUMN resolution_reason");
    sql.exec("ALTER TABLE app_papercuts DROP COLUMN resolution_note");

    for (const [id, resolved] of [
      ["open", null],
      ["done", 5],
    ] as const)
      sql.exec(
        `INSERT INTO app_papercuts (id, kind, source, message, signature, created_at, resolved_at)
         VALUES (?, 'error', 'model', 'Overloaded', 'model||overloaded', 1, ?)`,
        id,
        resolved,
      );

    const store = new Papercuts(sql);
    expect(store.read("open")).toMatchObject({ resolution_reason: null, resolution_note: null });
    expect(store.read("done")).toMatchObject({ resolution_reason: "fixed", resolved_at: 5 });
    expect(new Papercuts(sql).list({ status: "fixed" }).entries).toMatchObject([
      { id: "done", resolution_reason: "fixed" },
    ]);
  });
});

async function credentials() {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "private-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
}

async function entries() {
  // Every entry, open or resolved, with its full message.
  return runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);

    return (["open", "fixed"] as const).flatMap((status) =>
      store.list({ status, limit: 200 }).entries.map((entry) => store.read(entry.id)),
    );
  });
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

it("keeps every field of a redacted shell failure, so a bearer token can't swallow stderr", async () => {
  await credentials();
  const command = "curl -sS https://api.example.com/v1 -H 'Authorization: Bearer private-token'";

  const failure = (port: number) => ({
    output: [
      {
        type: "text" as const,
        text: JSON.stringify({
          stdout: "",
          stderr: `curl: (7) Failed to connect to api.example.com port ${port} after 3 ms: Couldn't connect to server`,
          exitCode: 7,
        }),
      },
    ],
  });

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    for (const port of [443, 8443])
      await agent["captureToolFailure"]({ name: "shell", arguments: { command } }, failure(port));
  });
  const rows = (await entries()).filter((row) => row.source === "tool:shell");
  expect(rows).toHaveLength(2);

  for (const row of rows) {
    expect(row.message).not.toContain("private-token");
    const summary = JSON.parse(row.message);
    expect(summary).toMatchObject({
      exitCode: 7,
      command: expect.stringContaining("Bearer [redacted]"),
    });
    expect(summary.stderr).toContain("Failed to connect to api.example.com");
    expect(row.signature).toBe(
      "tool:shell|7|curl: (<n>) failed to connect to api.example.com port <n> after <n> ms: couldn't connect to server",
    );
  }
});

it("registers the papercuts tool and captures failed tool results through the real harness", async () => {
  await credentials();
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const index = requests++;

    const item =
      index < 3
        ? {
            type: "function_call",
            id: `fc_${index}`,
            call_id: `call_${index}`,
            name: index === 1 ? "workspace" : "papercuts",
            arguments: JSON.stringify(
              [
                { action: "log", message: "Setup instructions omit private-refresh" },
                { action: "status" },
                {
                  action: "resolve",
                  signature: "agent||setup instructions omit [redacted]",
                  before: new Date(Date.now() + 60_000).toISOString(),
                  reason: "wontfix",
                  note: "Documented elsewhere",
                },
              ][index],
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
  await expect
    .poll(async () => (await entries()).find((row) => row.source === "agent")?.resolution_reason)
    .toBe("wontfix");
  const rows = await entries();
  expect(rows.find((row) => row.source === "agent")).toMatchObject({
    message: "Setup instructions omit [redacted]",
    resolved_at: expect.any(Number),
    resolution_reason: "wontfix",
    resolution_note: "Documented elsewhere",
  });
  expect(rows.find((row) => row.source === "tool:workspace")?.message).toContain(
    "Select a repository",
  );
  expect(rows.every((row) => row.conversation_id !== null)).toBe(true);
  expect(rows.every((row) => row.signature.length > 0)).toBe(true);
});

it("refuses to resolve papercuts from a read-only session", async () => {
  await credentials();

  const old = await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) =>
    logAt(new Papercuts(state.storage.sql), 1, { message: "Old failure" }),
  );

  const calls = [
    { action: "resolve_stale", olderThanDays: 0 },
    { action: "resolve", id: old, reason: "stale" },
    { action: "list", group: true },
  ];

  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const index = bodies.length;
    bodies.push(String(init?.body ?? ""));

    const item =
      index < calls.length
        ? {
            type: "function_call",
            id: `fc_${index}`,
            call_id: `call_${index}`,
            name: "papercuts",
            arguments: JSON.stringify(calls[index]),
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

  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;
    await agent["harness"].commit(async (tx) => {
      (await tx.doc(ConversationWorkspace, conversationId)).config = workspaceConfig(
        { repository: "example/project" },
        String(conversationId),
        { readOnly: true },
      );
    }, BACKGROUND_CONTEXT);
  });

  const submitted = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Clean up papercuts", requestId: crypto.randomUUID() }),
  });

  expect(submitted.status).toBe(202);
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBe(calls.length + 1);

  // Both resolves were refused and the list still answered.
  expect(bodies[1]).toContain("Read-only sessions can list and read papercuts");
  expect(bodies[2]).toContain("Read-only sessions can list and read papercuts");
  expect(bodies[3]).toContain("Old failure");
  const rows = await entries();
  expect(rows.find((row) => row.id === old)?.resolved_at).toBeNull();
});

it("logs github and workspace failures with their real error, action and repository", async () => {
  await credentials();

  const calls = [
    [
      "github",
      { operation: { action: "list_files", repository: "example/build-failures", ref: "main" } },
    ],
    ["workspace", { action: "status" }],
    ["workspace", { action: "commit", message: "x".repeat(1001) }],
    [
      "github",
      {
        operation: {
          action: "write_file",
          repository: "example/project",
          branch: "dolly/x",
          path: "a.txt",
          content: "",
          message: "x".repeat(201),
        },
      },
    ],
    [
      "github",
      { operation: { action: "read_file", repository: "example/gone", path: "a", ref: "main" } },
    ],
  ] as const;

  let requests = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (new URL(String(input)).hostname.endsWith("github.com"))
      return Response.json({ message: "Not Found" }, { status: 404 });
    const index = requests++;

    const call = calls[index];

    const item = call
      ? {
          type: "function_call",
          id: `fc_${index}`,
          call_id: `call_${index}`,
          name: call[0],
          arguments: JSON.stringify(call[1]),
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

  // A rejection such as a dropped connection, with the code Node and Workers errors carry.
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const github = agent["githubForSession"].bind(agent);
    agent["githubForSession"] = async (id, input) =>
      input.operation.action === "list_files" ? Promise.reject(reset) : github(id, input);
    agent["runWorkspace"] = async () => Promise.reject(new Error("Sandbox went away"));
  });
  await start();
  await expect.poll(async () => (await entries()).length).toBe(5);

  const messages = (await entries()).map((row) => `${row.source} ${row.message}`);
  expect(messages.join("\n")).not.toContain("Effect.tryPromise");
  expect(messages).toEqual(
    expect.arrayContaining([
      "tool:github socket hang up (code ECONNRESET)\n[github list_files on example/build-failures]",
      "tool:workspace Sandbox went away",
      expect.stringMatching(/^tool:workspace .*message: expected at most 1000 characters/s),
      expect.stringMatching(
        /^tool:github .*operation\.message: expected at most 200 characters.*\n\[github write_file on example\/project\]$/s,
      ),
    ]),
  );
  // The context names where it failed, never what: an error-like repository name isn't the key.
  expect((await entries()).find((row) => row.message.startsWith("socket hang up"))?.signature).toBe(
    "tool:github||socket hang up (code econnreset)",
  );
  const notFound = (await entries()).find((row) => row.message.includes("example/gone"));
  expect(JSON.parse(notFound!.message)).toMatchObject({
    action: "read_file",
    repository: "example/gone",
    message: expect.stringContaining("HTTP 404"),
  });
  expect(notFound!.signature).toBe("tool:github||provider returned http <n>: not found");
});

/** A tool result carrying one text part, as tools return them. */
type Reply = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  state?: string;
  updatedAt?: number;
  error?: string;
  workspaceSetup?: { state: string; updatedAt: number };
};

const reply = (value: Reply) => ({
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});

it("skips exit 1 with nothing on either stream, as in the entries logged before #178 deployed", () => {
  // One of the 61 `tool:shell|1|` entries, all logged on 2026-11-26, before the skip deployed.
  const empty = reply({
    stdout: "",
    stderr: "",
    exitCode: 1,
    workspaceSetup: { state: "ready", updatedAt: 1795701073347 },
  });

  for (const call of [
    undefined,
    { arguments: { command: "grep -rn 'parentId' web/e2e | head -5" } },
    { arguments: { command: "pnpm test 2>&1 | tail -5" } },
  ])
    expect(toolFailure(empty, call)).toBeUndefined();
});

it("keys a Node crash on its error line, not on Node's boilerplate or code frame", () => {
  // From entries grouped as `tool:shell|1|triggeruncaughtexception(`.
  const strip = JSON.stringify({
    exitCode: 1,
    command: "node --disable-warning=ExperimentalWarning --input-type=module <<'JS'",
    stderr: [
      "node:internal/modules/run_main:107",
      "    triggerUncaughtException(",
      "    ^",
      "",
      "file:///workspace/repo/src/papercuts.ts:169",
      "export class Papercuts {",
      "  constructor(private readonly sql: SqlStorage) {",
      "                               ^^^^^^^^^^^^^^^",
      "    sql.exec(`CREATE TABLE IF NOT EXISTS app_papercuts (",
      "",
      "SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode",
      "    at parseTypeScript (node:internal/modules/typescript:68:40)",
    ].join("\n"),
  });

  const path = JSON.stringify({
    stdout: "",
    stderr: [
      "node:path:1336",
      "      validateString(arg, 'path');",
      "      ^",
      "",
      'TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined',
      "    at Object.join (node:path:1336:7)",
    ].join("\n"),
    exitCode: 1,
  });

  const missing = JSON.stringify({
    stdout: "\n",
    stderr: [
      "cat: /tmp/card.json: No such file or directory",
      "node:fs:483",
      "    return binding.readFileUtf8(path, stringToFlags(options.flag));",
      "                   ^",
      "",
      "Error: ENOENT: no such file or directory, open '/tmp/card.json'",
      "    at Object.readFileSync (node:fs:483:20)",
    ].join("\n"),
    exitCode: 1,
  });

  expect(papercutSignature("tool:shell", strip)).toBe(
    "tool:shell|1|syntaxerror [err_unsupported_typescript_syntax]: typescript parameter property is not supported in strip-only mode",
  );
  expect(papercutSignature("tool:shell", path)).toBe(
    'tool:shell|1|typeerror [err_invalid_arg_type]: the "path" argument must be of type string. received undefined',
  );
  expect(papercutSignature("tool:shell", missing)).toBe(
    "tool:shell|1|error: enoent: no such file or directory, open '<path>'",
  );
});

it("keys a setup warning on what failed, not on the head of an install log cut to its tail", () => {
  // onlineornot-next's `.agents/setup exited 22`, split into groups by where the tail started.
  const log = (start: string) =>
    [
      start,
      ".../node_modules/.pnpm-efceae3c postinstall: Done",
      ".../node_modules/@sentry/.pnpm-efceae3c postinstall$ node ./scripts/install.js",
      "Agent skills awaiting approval: @tanstack/react-router, better-result.",
      'Run "pnpm approve" to review them.',
      "devDependencies:",
      "+ typescript 7.0.2",
      "Done in 42.5s using pnpm v12.21.0",
      "npm notice New major version of npm available! 11.19.1 -> 12.2.3",
      "Setup finished with problems:",
      "- .agents/setup exited 22",
      "",
    ].join("\n");

  const heads = [
    `odules/.pnpm-efceae3c postinstall$ node -e "import('./config/scripts/postinstall.js').catch(() => void 0)"`,
    "odules/.pnpm-65eb1774 postinstall: Done",
    `('./config/scripts/postinstall.js').catch(() => void 0)"`,
  ];

  const signatures = heads.map((start) =>
    papercutSignature(
      "tool:workspace",
      JSON.stringify({ state: "warning", updatedAt: 1795713768722, error: log(start) }),
    ),
  );

  expect(new Set(signatures)).toEqual(new Set(["tool:workspace||- .<path> exited <n>"]));

  // The stored summary keeps the problems section, and keys the same way.
  const summary = toolFailure(
    reply({
      state: "warning",
      updatedAt: 1795713768722,
      error: `${"x".repeat(1500)}${log(heads[0]!)}`,
    }),
  )!;

  expect(JSON.parse(summary)).toEqual({
    state: "warning",
    error: "Setup finished with problems:\n- .agents/setup exited 22",
  });
  expect(papercutSignature("tool:workspace", summary)).toBe(signatures[0]);

  // A `state` that is not a setup state is a tool's own data: never stored, never setup-clipped.
  const secret = JSON.parse(
    toolFailure(reply({ state: "Bearer private-token", error: "request failed" }))!,
  );

  expect(secret).toEqual({ error: "request failed" });

  // Summaries stored before `state` was kept had only the error's first 500 characters.
  expect(
    papercutSignature(
      "tool:workspace",
      JSON.stringify({
        error:
          "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/x\nSetup finished with problems:\n- .agents/setup exited 22",
      }),
    ),
  ).toBe(signatures[0]);

  // Without a problems section, the end of the log is kept.
  const plain = JSON.parse(
    toolFailure(reply({ state: "warning", error: `${"y".repeat(2000)}\nSetup exited 1` }))!,
  );

  expect(plain.error.endsWith("Setup exited 1")).toBe(true);
  expect(papercutSignature("tool:workspace", JSON.stringify(plain))).toBe(
    "tool:workspace||setup exited <n>",
  );
});

it("skips git, pnpm and lint-staged progress lines and ANSI codes when choosing the key line", () => {
  const fetch =
    "From http://github.workspace/onlineornot/onlineornot-next\n * branch            c91656966bfcc08bae1b7f4ea60d378fb5103cf0 -> FETCH_HEAD\n";

  // c078d578: the real error sat under git fetch's progress lines.
  expect(
    papercutSignature(
      "tool:shell",
      JSON.stringify({
        stdout: "lambdas/AGENTS.md\n  140 AGENTS.md\n",
        stderr: `${fetch}wc: apps/{,web-rr7/}AGENTS.md: No such file or directory\nwc: apps/web-rr7/{_content,app/components}/AGENTS.md: No such file or directory\n`,
        exitCode: 1,
        workspaceSetup: { state: "installing", updatedAt: 1795707881988 },
      }),
    ),
  ).toBe("tool:shell|1|wc: apps/{,web-rr<n>/}agents.md: no such file or directory");

  // 9542fc7c: progress alone says nothing; the command that ran does.
  expect(
    papercutSignature(
      "tool:shell",
      JSON.stringify({
        exitCode: 1,
        command: "git fetch --depth=1 origin 751d270f9128363284793adb5e69c63b544cb700 && git diff",
        stderr:
          "From http://github.workspace/rozenmd/dolly\n * branch            751d270f9128363284793adb5e69c63b544cb700 -> FETCH_HEAD",
      }),
    ),
  ).toBe("tool:shell|1|git");

  // Other git progress lines are skipped the same way.
  expect(
    papercutSignature(
      "tool:shell",
      JSON.stringify({
        exitCode: 128,
        stderr: [
          "remote: Enumerating objects: 5, done.",
          "remote: Counting objects: 100% (5/5), done.",
          "remote: Compressing objects: 100% (3/3), done.",
          "remote: Total 3 (delta 2), reused 0 (delta 0), pack-reused 0",
          "Receiving objects: 100% (3/3), done.",
          "Resolving deltas: 100% (2/2), done.",
          "From git@github.com:rozenmd/dolly",
          "   a1b2c3d..e4f5a6b  main       -> origin/main",
          " + 1a2b3c4...5d6e7f8 topic      -> origin/topic  (forced update)",
          "HEAD is now at e4f5a6b Fix things",
          "fatal: bad object 0123abcd",
        ].join("\n"),
      }),
    ),
  ).toBe("tool:shell|128|fatal: bad object <hash>");

  // A rejected push is a failure, not progress.
  expect(
    papercutSignature(
      "tool:shell",
      JSON.stringify({
        exitCode: 1,
        stderr:
          "To http://github.workspace/rozenmd/dolly\n ! [rejected]        HEAD -> main (fetch first)",
      }),
    ),
  ).toBe("tool:shell|1|! [rejected] head -> main (fetch first)");

  // ea14b23a, d5cc5678: a shell reply clipped at 4,000 characters whose only error-like text is
  // the setup status it ended with: that describes setup, not the command.
  const setup = `,"workspaceSetup":{"state":"warning","updatedAt":1795646315642,"error":"les/.pnpm-461938ce postinstall: Done\\n.../node_modules/.pnpm-461938ce postinstall$ node -e \\"import('./config/scripts/postinstall.js').catch(() => void 0)\\"\\n.../node_modules/@sentry/.pnpm-461938ce postinstall$ node ./scripts/install.js\\nAgent skills awaiting approval: @tan`;

  expect(
    papercutSignature(
      "tool:shell",
      `{"stdout":"workers/auth/package.json:14:    \\"build\\": \\"wrangler deploy\\",\\n","stderr":"","exitCode":1${setup}`,
    ),
  ).toBe("tool:shell|1|truncated tool result");

  // pnpm lifecycle lines never name a failure; `: Failed` does.
  const pnpm = [
    ".../node_modules/.pnpm-461938ce postinstall: Done",
    `.../node_modules/.pnpm-461938ce postinstall$ node -e "import('./config/scripts/postinstall.js').catch(() => void 0)"`,
    ". prepare$ husky",
    ". prepare: Done",
  ].join("\n");

  expect(
    papercutSignature("tool:shell", JSON.stringify({ exitCode: 1, stderr: `${pnpm}\nboom` })),
  ).toBe("tool:shell|1|boom");
  expect(
    papercutSignature(
      "tool:shell",
      JSON.stringify({
        exitCode: 1,
        stderr: `${pnpm}\n.../node_modules/esbuild postinstall: Failed`,
      }),
    ),
  ).toBe("tool:shell|1|.<path> postinstall: failed");

  // c50d1a16: lint-staged's progress on stderr of a commit that went through.
  const lintStaged = [
    "[STARTED] Backing up original state...",
    "[COMPLETED] Backed up original state in git stash (f4906a891)",
    '[STARTED] oxfmt --write --config "/workspace/x/apps/web-rr7/.oxfmtrc.json" --ignore-path "/workspace/x/.oxfmtignore" --no-error-on-unmatched-pattern',
    "[COMPLETED] Cleaning up temporary files...",
  ].join("\n");

  expect(
    papercutSignature(
      "tool:shell",
      JSON.stringify({ exitCode: 1, command: "git commit -m x", stderr: lintStaged }),
    ),
  ).toBe("tool:shell|1|git");
  expect(
    papercutSignature(
      "tool:shell",
      JSON.stringify({
        exitCode: 1,
        stderr: `${lintStaged}\n[FAILED] oxfmt --write [FAILED]\n✖ oxfmt found errors`,
      }),
    ),
  ).toBe("tool:shell|1|[failed] oxfmt --write [failed]");

  // 967b5f97: vitest's coloured banner is not the key; colour codes never reach a signature.
  expect(
    papercutSignature(
      "tool:shell",
      `{"stdout":"\\n\\u001b[1m RUN \\u001b[22m","stderr":"\\u001b[90mstderr\\u001b[2m | src/docs-screenshots-browser.test.ts\\u001b[2m > \\u001b[22m\\u001b[2mcaptures docs screenshots\\n\\u001b[22m\\u001b[39m2026-11-26T14:14:52.981Z WARN [Better Auth]: Social provider google is missing clientId or clientSecret\\n\\u001b[90mstderr\\u001b[2m | src/a.test.ts`,
    ),
  ).toBe(
    "tool:shell||<time> warn [better auth]: social provider google is missing clientid or clientsecret",
  );
});

it("keys a failure with nothing on stderr on the command that ran, not on stdout", () => {
  const summary = (command: string, stdout: string, exitCode = 1) =>
    toolFailure(reply({ stdout, stderr: "", exitCode }), { arguments: { command } })!;

  // From groups keyed on `✓ built in <n>s`, a grep match and `<p>`.
  const built = summary(
    "pnpm build 2>&1 | tail -3",
    ".cloudflare/output/v1/workers/default/bundle/index.js  5,656.21 kB\n\n✓ built in 3.91s\n",
    124,
  );

  expect(papercutSignature("tool:shell", built)).toBe("tool:shell|124|pnpm");
  expect(papercutSignature("tool:shell", summary("cd web && pnpm build", "✓ built in 2.17s"))).toBe(
    "tool:shell|1|pnpm",
  );
  expect(
    papercutSignature(
      "tool:shell",
      summary("git rev-parse HEAD; git grep -n mcp -- workers/app.ts; sed -n 1,5p a.html", "<p>"),
    ),
  ).toBe("tool:shell|1|git");
  expect(
    papercutSignature(
      "tool:shell",
      summary(
        "FORCE_COLOR=0 node scripts/check.mjs",
        "src/sandbox.ts:916:              snapshotId: snapshot?.id ?? null,",
      ),
    ),
  ).toBe("tool:shell|1|node");

  // A thrown error printed on stdout still names the failure.
  expect(
    papercutSignature(
      "tool:shell",
      summary(
        "cat durations.json | node -e 'JSON.parse(require(\"fs\").readFileSync(0))'",
        "undefined:1\n\nSyntaxError: Unexpected end of JSON input",
      ),
    ),
  ).toBe("tool:shell|1|syntaxerror: unexpected end of json input");
});

it("groups a missing command by the command, whatever the shell or exit code", () => {
  const shell = (stderr: string, exitCode: number) =>
    papercutSignature("tool:shell", JSON.stringify({ stdout: "", stderr, exitCode }));

  for (const [stderr, exitCode] of [
    ["sh: 1: python: not found\n", 127],
    ["sh: 13: python: not found", 2],
    ["bash: line 1: python: command not found", 127],
    ["/bin/sh: 1: python: not found", 1],
    ["zsh: command not found: python", 127],
  ] as const)
    expect(shell(stderr, exitCode)).toBe("tool:shell||command not found: python");
  expect(shell("sh: 1: rg: not found", 127)).toBe("tool:shell||command not found: rg");
});

it("keys a result the harness wrote on its first line, not on the partial output after it", () => {
  for (const message of [
    "Tool shell was interrupted and may have partially run",
    "Tool shell was interrupted and may have partially run\nverify=0\nFound 0 warnings and 0 errors.",
    "Tool shell was interrupted and may have partially run\n== 9101\n ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'http://127.0.0.1:9101/r.git'",
  ])
    expect(papercutSignature("tool:shell", message)).toBe(
      "tool:shell||tool shell was interrupted and may have partially run",
    );
  expect(papercutSignature("tool:shell", "Tool shell was aborted\nbuild 0")).toBe(
    "tool:shell||tool shell was aborted",
  );
});

it("drops a repeat of one signature from the same conversation within ten seconds", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const store = new Papercuts(state.storage.sql);

    const message = (line: number) =>
      JSON.stringify({ exitCode: 2, stderr: `src/sandbox.ts:${line}: snapshotId: snapshot?.id` });

    const first = logAt(store, 1_000_000, { conversationId: "a", message: message(556) });
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000_150);
    expect(
      store.log({
        kind: "error",
        source: "tool:shell",
        conversationId: "a",
        message: message(916),
      }),
    ).toEqual({ id: first, duplicate: true });

    // Another conversation, a later repeat, and manual logs without a conversation all count.
    logAt(store, 1_000_200, { conversationId: "b", message: message(916) });
    logAt(store, 1_010_001, { conversationId: "a", message: message(916) });
    logAt(store, 1_010_002, { message: message(916) });
    logAt(store, 1_010_003, { message: message(916) });
    expect(store.list().total).toBe(5);

    // A repeat right after its entry was resolved is a recurrence, not a duplicate.
    const fixed = logAt(store, 2_000_000, { conversationId: "c", message: message(1) });
    vi.spyOn(Date, "now").mockReturnValueOnce(2_000_100);
    store.resolve({ id: fixed });
    const again = logAt(store, 2_000_200, { conversationId: "c", message: message(1) });
    expect(again).not.toBe(fixed);
    expect(
      store
        .list({ signature: papercutSignature("tool:shell", message(1)) })
        .entries.filter((entry) => entry.conversation_id === "c"),
    ).toEqual([expect.objectContaining({ id: again })]);
  });
});

it("recomputes open entries' signatures once when the algorithm changes, leaving resolved ones", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const sql = state.storage.sql;
    // The Agent already ran the current migration; go back to before the version marker.
    new Papercuts(sql);
    sql.exec("DROP TABLE app_papercuts_meta");

    const rows = [
      ["a", "tool:workspace||npm err! code e<n>", null],
      [
        "b",
        "tool:workspace||<path> postinstall$ node -e \"import('<path>').catch(() => void <n>)\"",
        null,
      ],
      ["c", "tool:shell|1|triggeruncaughtexception(", null],
      ["d", "tool:shell|1|triggeruncaughtexception(", 5],
      ["e", "tool:shell|1|from <url>", null],
    ] as const;

    const messages = {
      // The shape main stored: the error's first 500 characters, without `state`.
      a: JSON.stringify({
        error:
          "npm ERR! code E404\nodules/.pnpm-65eb1774 postinstall: Done\nSetup finished with problems:\n- .agents/setup exited 22",
      }),
      b: JSON.stringify({
        state: "warning",
        error: `odules/.pnpm-efceae3c postinstall$ node -e "import('./config/scripts/postinstall.js').catch(() => void 0)"\nSetup finished with problems:\n- .agents/setup exited 22\n`,
      }),
      c: JSON.stringify({
        exitCode: 1,
        stderr:
          "node:internal/modules/run_main:107\n    triggerUncaughtException(\n    ^\n\nTypeError: x is not a function",
      }),
      d: JSON.stringify({
        exitCode: 1,
        stderr:
          "node:internal/modules/run_main:107\n    triggerUncaughtException(\n    ^\n\nTypeError: x is not a function",
      }),
      e: JSON.stringify({
        exitCode: 1,
        stderr:
          "From http://github.workspace/a/b\n * branch            c91656966bfcc08bae1b7f4ea60d378fb5103cf0 -> FETCH_HEAD\nwc: x: No such file or directory",
      }),
    };

    for (const [id, signature, resolved] of rows)
      sql.exec(
        `INSERT INTO app_papercuts (id, kind, source, message, signature, created_at, resolved_at)
         VALUES (?, 'error', ?, ?, ?, 1, ?)`,
        id,
        signature.split("|")[0]!,
        messages[id],
        signature,
        resolved,
      );

    const signatures = () =>
      Object.fromEntries(
        sql
          .exec<{ id: string; signature: string }>(
            "SELECT id, signature FROM app_papercuts WHERE id IN ('a', 'b', 'c', 'd', 'e')",
          )
          .toArray()
          .map((row) => [row.id, row.signature]),
      );

    new Papercuts(sql);
    expect(signatures()).toEqual({
      a: "tool:workspace||- .<path> exited <n>",
      b: "tool:workspace||- .<path> exited <n>",
      c: "tool:shell|1|typeerror: x is not a function",
      d: "tool:shell|1|triggeruncaughtexception(",
      e: "tool:shell|1|wc: x: no such file or directory",
    });
    expect(
      sql.exec("SELECT value FROM app_papercuts_meta WHERE key = 'signature_version'").one().value,
    ).toBe(SIGNATURE_VERSION);

    // Once: a later start leaves signatures alone.
    sql.exec("UPDATE app_papercuts SET signature = 'kept' WHERE id = 'a'");
    new Papercuts(sql);
    expect(signatures().a).toBe("kept");
  });
});

it("does not log calls the harness cut off for a steer, a restart or a deliberate stop", async () => {
  await credentials();
  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();

  const conversationId = (await runInDurableObject(env.AGENT.getByName("owner"), (_, state) =>
    state.storage.get<ConversationId>(`session:${id}`),
  ))!;

  expect(conversationId).toBeDefined();
  const shell = { name: "shell", arguments: { command: "pnpm verify && pnpm test" } };

  const harness = (code: string, message: string, output = "") => ({
    output: output ? [{ type: "text" as const, text: output }] : [],
    isError: true,
    diagnostics: [{ severity: "error" as const, code, message }],
  });

  const killed = reply({
    stdout: "",
    stderr: "",
    exitCode: 143,
    workspaceSetup: { state: "ready", updatedAt: 1795766983118 },
  });

  const logged = async () =>
    (await entries())
      .filter((row) => row.conversation_id === String(conversationId))
      .map((row) => row.message);

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const capture = agent["captureToolFailure"].bind(agent);

    // Never failures: a call skipped for the owner's steer, and calls a restart cut off.
    await capture(
      { name: "mcp" },
      harness("blocked", `Tool call blocked: ${STEER_TOOL_SKIP}`),
      conversationId,
    );
    await capture(
      shell,
      harness(
        "interrupted",
        "Tool shell was interrupted and may have partially run",
        "verify=0\nFound 0 warnings and 0 errors.",
      ),
      conversationId,
    );
    await capture(
      shell,
      harness("interrupted", "Tool shell was interrupted by a restart and may have partially run"),
      conversationId,
    );
    // A command still running when its own call was aborted.
    await capture(shell, killed, conversationId, true);
  });
  expect(await logged()).toEqual([]);

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    // Nobody here stopped the run: a genuine abort, or a command killed by something else.
    await agent["captureToolFailure"](
      shell,
      harness("aborted", "Tool shell was aborted"),
      conversationId,
    );
    await agent["captureToolFailure"](
      { name: "shell", arguments: { command: "pkill -f server.mjs; node server.mjs" } },
      killed,
      conversationId,
    );
    // Other blocks are still failures.
    await agent["captureToolFailure"](
      { name: "github" },
      harness("blocked", "Tool call blocked: read-only session"),
      conversationId,
    );
  });
  expect(await logged()).toHaveLength(3);

  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    // After the owner stops the run, the calls it had in flight are not failures.
    agent["stops"].set(String(conversationId), {
      at: Date.now(),
      calls: new Set(["call_github", "call_shell"]),
    });
    await agent["captureToolFailure"](
      { id: "call_github", name: "github" },
      harness("aborted", "Tool github was aborted"),
      conversationId,
    );
    await agent["captureToolFailure"]({ id: "call_shell", ...shell }, killed, conversationId);
    // The replacement run's own calls are.
    await agent["captureToolFailure"]({ id: "call_next", ...shell }, killed, conversationId);
  });
  const rows = await logged();
  expect(rows).toHaveLength(4);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.stringContaining('"exitCode":143,"command":"pnpm verify'),
      "Tool call blocked: read-only session",
      expect.stringContaining('"command":"pkill'),
      "Tool shell was aborted",
    ]),
  );
});

it("groups preview errors across ports, times and pages under the current signatures", () => {
  // Messages from preview.ts and browser-preview.ts; their varying parts must not split groups.
  const pairs = [
    [
      "Dev server on port 5173 exited at 2026-11-27T10:00:00.000Z; check preview status logs, then use preview start again",
      "Dev server on port 3000 exited at 2026-11-28T09:12:44.123Z; check preview status logs, then use preview start again",
    ],
    [
      "Preview page http://127.0.0.1:5173/ did not fire its load event within 20 seconds; the page never loaded (a dev server compiling this route on first request can take this long: retry, and check preview status logs)",
      "Preview page http://127.0.0.1:3000/settings did not fire its load event within 20 seconds; the page never loaded (a dev server compiling this route on first request can take this long: retry, and check preview status logs)",
    ],
    [
      "The sandbox restarted at 2026-11-27T10:00:00.000Z, which ended the preview on port 5173 started at 2026-11-27T09:50:00.000Z; use preview start again",
      "The sandbox restarted at 2026-11-27T11:00:00.000Z, which ended the preview on port 8080 started at 2026-11-27T10:58:00.000Z; use preview start again",
    ],
  ] as const;

  for (const [first, second] of pairs) {
    expect(papercutSignature("tool:preview", first)).toBe(
      papercutSignature("tool:preview", second),
    );
    expect(papercutSignature("tool:preview", first)).not.toMatch(/\d/);
  }
});
