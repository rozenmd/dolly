import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import { PAGE_BYTES, Papercuts, papercutSignature, toolFailure } from "../src/papercuts";
import { ConversationWorkspace, workspaceConfig } from "../src/workspace";
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

it("gives repeats of one failure the same signature and different failures different ones", () => {
  const shell = (stderr: string, exitCode = 127) => JSON.stringify({ exitCode, stderr });
  expect(papercutSignature("tool:shell", shell("sh: 1: rg: not found"))).toBe(
    "tool:shell|127|sh: <n>: rg: not found",
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
  expect(papercutSignature("tool:shell", shell("sh: 1: rg: not found"))).not.toBe(
    papercutSignature("tool:shell", shell("sh: 1: rg: not found", 1)),
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
    "tool:shell|127|sh: <n>: rg: not found",
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
      { id: "old", signature: "tool:shell|127|sh: <n>: rg: not found" },
    ]);
    store.log({ kind: "error", source: "model", message: "Overloaded" });
    expect(new Papercuts(sql).list().entries.map((row) => row.signature)).toEqual([
      "model||overloaded",
      "tool:shell|127|sh: <n>: rg: not found",
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

    logAt(store, 200, { conversationId: "a", repository: "org/a", message: notFound(2) });
    logAt(store, 300, { conversationId: "b", repository: "org/b", message: notFound(3) });
    logAt(store, 250, { kind: "improvement", source: "agent", message: "Docs are missing" });

    vi.spyOn(Date, "now").mockReturnValueOnce(150);
    expect(store.resolve({ id: fixed })).toEqual({ resolved: 1 });

    const { groups, total, more } = store.groups();
    expect({ total, more }).toEqual({ total: 2, more: false });
    expect(groups).toMatchObject([
      {
        signature: "tool:shell|127|sh: <n>: rg: not found",
        count: 2,
        sessions: 2,
        repositories: ["org/a", "org/b"],
        repository_count: 2,
        first_seen: 200,
        last_seen: 300,
        sample_message: notFound(3),
        last_resolved_at: 150,
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
