import { env } from "cloudflare:workers";
import { zstdDecompressSync } from "node:zlib";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

let roots: string[] = [];

const headers = { Authorization: "Bearer test-token-with-at-least-32-characters" };
const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
const Created = Schema.Struct({ id: Schema.String, model: Schema.String, taskId: Schema.String });

const Receipt = Schema.Struct({
  status: Schema.String,
  outcome: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Struct({
      status: Schema.String,
      text: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String),
    }),
  ),
});

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

function answer(text = "Child answer") {
  return sse({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
}

async function post(path: string, body: Record<string, string | undefined>) {
  return SELF.fetch(`https://worker/api/sessions/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function root() {
  const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await response.json<{ id: string }>();
  roots.push(id);

  return id;
}

async function spawn(parent: string, content = "Child prompt", model?: string) {
  const response = await post(`${parent}/children`, {
    content,
    model,
    requestId: crypto.randomUUID(),
  });

  expect(response.status).toBe(202);

  return Schema.decodeUnknownSync(Created)(await response.json());
}

async function receipt(parent: string, taskId: string) {
  const response = await SELF.fetch(`https://worker/api/sessions/${parent}/tasks/${taskId}`, {
    headers,
  });

  expect(response.status).toBe(200);

  return Schema.decodeUnknownSync(Receipt)(await response.json());
}

beforeEach(async () => {
  await reset();
  roots = [];
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
});

afterEach(async () => {
  for (const id of roots) await post(`${id}/abort`, {});
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("creates children atomically, deduplicates concurrent requests, persists receipts and scopes messaging", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
  const parent = await root();
  const body = { content: "Child prompt", model: "gpt-6-sol", requestId: crypto.randomUUID() };

  const responses = await Promise.all([
    post(`${parent}/children`, body),
    post(`${parent}/children`, body),
  ]);

  expect(responses.map((response) => response.status)).toEqual([202, 202]);
  const child = Schema.decodeUnknownSync(Created)(await responses[0].json());
  expect(await responses[1].json()).toEqual(child);
  await expect.poll(async () => (await receipt(parent, child.taskId)).status).toBe("terminal");
  expect(await receipt(parent, child.taskId)).toMatchObject({
    outcome: "completed",
    result: { status: "answered", text: "Child answer" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await post(`${parent}/children`, { ...body, content: "Changed" })).status).toBe(409);
  await abortAllDurableObjects();
  expect(await (await post(`${parent}/children`, body)).json()).toEqual(child);
  expect(
    await (await SELF.fetch(`https://worker/api/sessions/${parent}/children`, { headers })).json(),
  ).toEqual({ children: [child] });
  expect((await SELF.fetch(`https://worker/api/sessions/${child.id}`, { headers })).status).toBe(
    200,
  );
  const other = await root();
  expect(
    (await SELF.fetch(`https://worker/api/sessions/${other}/tasks/${child.taskId}`, { headers }))
      .status,
  ).toBe(404);
  expect(
    (
      await post(`${other}/children/${child.id}/messages`, {
        content: "No",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const followUp = { content: "More", requestId: crypto.randomUUID() };
  const sent = await post(`${parent}/children/${child.id}/messages`, followUp);
  const delivery = await sent.json<{ taskId: string }>();
  expect(sent.status).toBe(202);
  expect(await (await post(`${parent}/children/${child.id}/messages`, followUp)).json()).toEqual(
    delivery,
  );
  await expect.poll(async () => (await receipt(parent, delivery.taskId)).status).toBe("terminal");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("enforces depth and width limits on the server, including after recovery", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
  const parent = await root();
  let current = parent;

  for (let depth = 0; depth < 3; depth++) {
    const child = await spawn(current, "Child prompt", depth === 0 ? "gpt-6-sol" : undefined);
    expect(child.model).toBe("gpt-6-sol");
    await expect.poll(async () => (await receipt(current, child.taskId)).status).toBe("terminal");
    current = child.id;
  }

  await abortAllDurableObjects();

  const rejected = await post(`${current}/children`, {
    content: "Too deep",
    requestId: crypto.randomUUID(),
  });

  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ error: "Nesting limit reached (3 child levels)" });

  for (let count = 1; count < 8; count++) {
    const child = await spawn(parent);
    await expect.poll(async () => (await receipt(parent, child.taskId)).status).toBe("terminal");
  }

  expect(
    (await post(`${parent}/children`, { content: "Too wide", requestId: crypto.randomUUID() }))
      .status,
  ).toBe(409);
});

it.each([false, true])(
  "lets the model spawn, await and consume a child result (restart=%s)",
  async (restart) => {
    let recovered = !restart;
    let childModel = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      const encoded = new Uint8Array(await new Response(init?.body).arrayBuffer());

      const bytes =
        new Headers(init?.headers).get("content-encoding") === "zstd"
          ? zstdDecompressSync(encoded)
          : encoded;

      const request = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Unknown) }),
        ),
      )(new TextDecoder().decode(bytes));

      const serialized = JSON.stringify(request.input);

      if (request.model === "gpt-6-sol") {
        childModel = request.model;

        if (!recovered)
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });

        return answer("Delegated result");
      }

      const outputs = request.input.flatMap((item) =>
        Option.toArray(
          Schema.decodeUnknownOption(
            Schema.Struct({
              type: Schema.Literals(["function_call_output"]),
              output: Schema.String,
            }),
          )(item),
        ),
      );

      const toolOutput = outputs.at(-1);

      if (!toolOutput)
        return sse({
          type: "function_call",
          id: "fc_spawn",
          call_id: "call_spawn",
          name: "spawn_task",
          arguments: JSON.stringify({ content: "Child job", model: "gpt-6-sol" }),
        });

      if (serialized.includes("Delegated result"))
        return answer("Parent consumed delegated result");
      const parsed = Schema.decodeUnknownSync(Schema.Struct({ output: Schema.String }))(toolOutput);

      const task = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ taskId: Schema.String })),
      )(parsed.output);

      return sse({
        type: "function_call",
        id: "fc_wait",
        call_id: "call_wait",
        name: "wait_for_task",
        arguments: JSON.stringify({ taskId: task.taskId }),
      });
    });
    const parent = await root();
    expect(
      (
        await post(`${parent}/messages`, {
          content: "Delegate this",
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(202);

    if (restart) {
      await expect
        .poll(
          async () =>
            (await SELF.fetch(`https://worker/api/sessions/${parent}`, { headers })).text(),
          { timeout: 2000 },
        )
        .toContain('"name":"wait_for_task","arguments":');
      await expect.poll(() => childModel).toBe("gpt-6-sol");
      recovered = true;
      await abortAllDurableObjects();
    }

    await expect
      .poll(
        async () => (await SELF.fetch(`https://worker/api/sessions/${parent}`, { headers })).text(),
        { timeout: 4000 },
      )
      .toContain("Parent consumed delegated result");
    expect(childModel).toBe("gpt-6-sol");

    const listing = await (
      await SELF.fetch(`https://worker/api/sessions/${parent}/children`, { headers })
    ).json<{ children: { id: string }[] }>();

    expect(listing.children).toHaveLength(1);

    const childTranscript = await (
      await SELF.fetch(`https://worker/api/sessions/${listing.children[0].id}`, { headers })
    ).json<{ entries: { kind: string }[] }>();

    expect(childTranscript.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
  },
);

it.each(["child", "root"])(
  "recursively aborts children and queued deliveries from %s",
  async (target) => {
    // Finish provider initialization before introducing intentionally blocked requests.
    let blocked = false;
    let aborted = 0;
    let started = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      if (!blocked) return answer();
      started++;

      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const parent = await root();
    const child = await spawn(parent);
    await expect.poll(async () => (await receipt(parent, child.taskId)).status).toBe("terminal");
    blocked = true;
    const grandchild = await spawn(child.id);
    await expect.poll(() => started).toBe(1);

    const sent = await post(`${parent}/children/${child.id}/messages`, {
      content: "Blocked",
      requestId: crypto.randomUUID(),
    });

    const message = await sent.json<{ taskId: string }>();
    await expect.poll(() => started).toBe(2);

    const queued = await post(`${parent}/children/${child.id}/messages`, {
      content: "Queued",
      requestId: crypto.randomUUID(),
    });

    const queuedMessage = await queued.json<{ taskId: string }>();
    expect((await post(`${target === "child" ? child.id : parent}/abort`, {})).status).toBe(200);
    expect(aborted).toBe(2);
    await expect
      .poll(async () => (await receipt(parent, queuedMessage.taskId)).status)
      .toBe("terminal");
    expect((await receipt(parent, message.taskId)).outcome).toBe("aborted");
    expect((await receipt(child.id, grandchild.taskId)).outcome).toBe("aborted");
    expect(started).toBe(2);
    blocked = false;

    const resumed = await post(`${parent}/children/${child.id}/messages`, {
      content: "New work",
      requestId: crypto.randomUUID(),
    });

    const next = await resumed.json<{ taskId: string }>();
    await expect
      .poll(async () => (await receipt(parent, next.taskId)).result?.text)
      .toBe("Child answer");
  },
);

it("bounds child message deliveries and validates authenticated HTTP inputs", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    answer(`Bearer abc ${access} test-refresh`),
  );
  const parent = await root();

  for (const body of [
    { content: "", requestId: crypto.randomUUID() },
    { content: "Hi", requestId: "bad" },
    { content: "Hi", requestId: crypto.randomUUID(), model: "unknown" },
  ]) {
    expect((await post(`${parent}/children`, body)).status).toBe(400);
  }

  const child = await spawn(parent);
  await expect.poll(async () => (await receipt(parent, child.taskId)).status).toBe("terminal");
  const result = JSON.stringify(await receipt(parent, child.taskId));
  expect(result).toContain("Bearer [redacted]");
  expect(result).not.toContain(access);
  expect(result).not.toContain("test-refresh");

  for (let count = 1; count < 32; count++) {
    const response = await post(`${parent}/children/${child.id}/messages`, {
      content: "Next",
      requestId: crypto.randomUUID(),
    });

    expect(response.status).toBe(202);
    const task = await response.json<{ taskId: string }>();
    await expect.poll(async () => (await receipt(parent, task.taskId)).status).toBe("terminal");
  }

  expect(
    (
      await post(`${parent}/children/${child.id}/messages`, {
        content: "Over budget",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});

it("returns an unanswered receipt when a child hits its tool-turn limit", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    sse({
      type: "function_call",
      id: "fc_status",
      call_id: "call_status",
      name: "task_status",
      arguments: JSON.stringify({ taskId: "missing" }),
    }),
  );
  const parent = await root();
  const child = await spawn(parent);
  await expect
    .poll(async () => (await receipt(parent, child.taskId)).status, { timeout: 4000 })
    .toBe("terminal");
  expect(await receipt(parent, child.taskId)).toMatchObject({
    outcome: "completed",
    result: { status: "unanswered", reason: "turn_limit" },
  });
});
