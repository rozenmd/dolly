import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Snapshot } from "../src/transcript";
import { headers, signIn } from "./session";

/**
 * The write_file and edit_file tools run through Pi, the Agent Durable Object and
 * the Sandbox Durable Object's RPC surface. Only the container filesystem is
 * simulated (an in-memory stand-in for Sandbox Files with Linux error semantics);
 * test/container/sandbox.test.ts covers the same operations against a real container.
 */

function fileError(code: string, operation: string, path: string) {
  return Object.assign(new Error(`${code}: ${path}`), {
    name: "SandboxFileError",
    code,
    operation,
    path,
    detail: code,
  });
}

function memoryFiles() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(["/", "/workspace"]);
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

  return {
    files,
    stat: async (path: string) => {
      const file = files.get(path);

      if (file) return { type: "file", size: BigInt(file.byteLength) };

      if (directories.has(path)) return { type: "directory", size: 4096n };

      throw fileError("ENOENT", "stat", path);
    },
    readFile: async (path: string) => {
      const file = files.get(path);

      if (!file) throw fileError("ENOENT", "readFile", path);

      return new Response(file);
    },
    writeFile: async (path: string, content: string) => {
      if (!directories.has(parent(path))) throw fileError("ENOENT", "writeFile", path);

      files.set(path, new TextEncoder().encode(content));
    },
    mkdir: async (path: string, options?: { recursive?: boolean }) => {
      if (!options?.recursive && !directories.has(parent(path)))
        throw fileError("ENOENT", "mkdir", path);

      for (let current = path; current !== "/"; current = parent(current)) directories.add(current);
    },
  };
}

const calls = [
  {
    name: "write_file",
    arguments: { path: "src/app.ts", content: "const a = 1;\nconst a = 1;\nexport {};\n" },
  },
  {
    name: "edit_file",
    arguments: { path: "src/app.ts", old_string: "const a = 1;", new_string: "const b = 2;" },
  },
  {
    name: "edit_file",
    arguments: {
      path: "src/app.ts",
      old_string: "const a = 1;",
      new_string: "const b = 2;",
      replace_all: true,
    },
  },
  {
    name: "edit_file",
    arguments: { path: "/workspace/src/app.ts", old_string: "export {};\n", new_string: "" },
  },
  { name: "edit_file", arguments: { path: "missing.ts", old_string: "a", new_string: "b" } },
  { name: "write_file", arguments: { path: "src/app.ts", content: "const b = 2;\n" } },
];

function codexEvents(index: number) {
  const call = calls[index];

  const item = call
    ? {
        type: "function_call",
        id: `fc_${index}`,
        call_id: `call_${index}`,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      }
    : {
        type: "message",
        id: "msg_files",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Files updated", annotations: [] }],
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
}

async function post<A>(path: string, body: A) {
  return SELF.fetch(`https://worker${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await reset();
  await signIn();
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("writes and edits sandbox files through Pi tools, reporting line diff stats and clear failures", async () => {
  const created = await (await post("/api/sessions", {})).json<{ id: string }>();

  const conversation = await runInDurableObject(env.AGENT.getByName("owner"), (_, state) =>
    state.storage.get(`session:${created.id}`),
  );

  const filesystem = memoryFiles();
  await runInDurableObject(env.SANDBOX.getByName(String(conversation)), async (instance) => {
    Object.assign(instance, { files: () => Effect.succeed(filesystem) });
  });

  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toContain("api.openai.com");

    return codexEvents(requests++);
  });

  expect(
    (
      await post(`/api/sessions/${created.id}/messages`, {
        content: "Create and edit src/app.ts",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);
  // The turn runs several model rounds and tool calls; the default 1s poll is too tight on CI.
  await expect
    .poll(
      async () =>
        (await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })).text(),
      { timeout: 15_000 },
    )
    .toContain("Files updated");

  const raw = await (
    await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })
  ).text();

  const snapshot = Schema.decodeUnknownSync(Snapshot)(JSON.parse(raw));

  const results = snapshot.entries
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult")
    .map((message) => ({
      tool: message.toolName,
      isError: message.isError,
      text: Schema.is(Schema.String)(message.content)
        ? message.content
        : message.content.map((block) => block.text).join(""),
    }));

  const file = "/workspace/src/app.ts";

  expect(results).toEqual([
    {
      tool: "write_file",
      isError: false,
      text: JSON.stringify({ path: file, created: true, added: 3, removed: 0 }),
    },
    {
      tool: "edit_file",
      isError: true,
      text: expect.stringContaining(
        `old_string matches 2 places in ${file}. Include more surrounding lines to make it unique, or set replace_all to change every match.`,
      ),
    },
    {
      tool: "edit_file",
      isError: false,
      text: JSON.stringify({ path: file, replacements: 2, added: 2, removed: 2 }),
    },
    {
      tool: "edit_file",
      isError: false,
      text: JSON.stringify({ path: file, replacements: 1, added: 0, removed: 1 }),
    },
    {
      tool: "edit_file",
      isError: true,
      text: expect.stringContaining(
        "/workspace/missing.ts does not exist; use write_file to create it",
      ),
    },
    {
      tool: "write_file",
      isError: false,
      text: JSON.stringify({ path: file, created: false, added: 0, removed: 1 }),
    },
  ]);
  expect(requests).toBe(calls.length + 1);

  // The tools' JSON schemas reach the model as part of the conversation's tool set.
  expect(raw).toContain('"name":"edit_file","description":"Edit an existing UTF-8 file');
  expect(new TextDecoder().decode(filesystem.files.get("/workspace/src/app.ts"))).toBe(
    "const b = 2;\n",
  );
});
