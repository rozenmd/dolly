import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type ConversationId } from "@earendil-works/pi-durable";
import { Papercuts, papercutSignature, toolFailure } from "../src/papercuts";
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
    expect(store.list()).toMatchObject([
      { id: "old", signature: "tool:shell|127|sh: <n>: rg: not found" },
    ]);
    store.log({ kind: "error", source: "model", message: "Overloaded" });
    expect(new Papercuts(sql).list().map((row) => row.signature)).toEqual([
      "model||overloaded",
      "tool:shell|127|sh: <n>: rg: not found",
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
  expect(rows.every((row) => row.signature.length > 0)).toBe(true);
});
