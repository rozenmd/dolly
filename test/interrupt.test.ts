import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Live, Snapshot } from "../src/transcript";
import { INTERRUPT_NOTE, stripInterruptNote } from "../src/interrupt-message";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { OwnerInputDoc } from "../src/automation-tool";
import { InterruptDoc } from "../src/queue";
import { headers, signIn } from "./session";
import { mockFetch } from "./titles";

/**
 * "Interrupt and send now" through the HTTP API, the Agent Durable Object, Pi and the Sandbox
 * Durable Object: a steer waiting behind a long-running command stops the turn (killing the
 * command), and is answered as the next turn at once; the rest of the queue waits its turn. Only
 * the container process and the model are simulated.
 */

type Script = (stopped: Promise<number>) => Promise<number>;

/** A container whose commands are scripts that end when they are stopped. */
function fakeContainer(scripts: Record<string, Script>) {
  const kills: { command: string; signal: number }[] = [];

  return {
    kills,
    running: true,
    exec: async (argv: string[]) => {
      const command = argv[2]!;
      const script = scripts[command];

      if (!script) throw new Error(`Unexpected command: ${command}`);

      const stop = Promise.withResolvers<number>();
      const output = () => new ReadableStream<Uint8Array>({ start: () => {} });
      const exitCode = script(stop.promise);

      return {
        stdout: output(),
        stderr: output(),
        exitCode,
        kill: (signal: number) => {
          kills.push({ command, signal });
          stop.resolve(signal);
        },
      };
    },
  };
}

/** A Codex response: a shell call, or an answer. */
function codex(index: number, reply: { command: string } | { text: string }) {
  const item =
    "command" in reply
      ? {
          type: "function_call",
          id: `fc_${index}`,
          call_id: `call_${index}`,
          name: "shell",
          arguments: JSON.stringify({ command: reply.command }),
        }
      : {
          type: "message",
          id: `msg_${index}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: reply.text, annotations: [] }],
        };

  const events = [
    { type: "response.created", response: { id: `resp_${index}`, status: "in_progress" } },
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

type Body = Readonly<Record<string, string | boolean>>;

function post(path: string, body?: Body) {
  const init: RequestInit = { method: "POST", headers };

  if (body) init.body = JSON.stringify(body);

  return SELF.fetch(`https://worker${path}`, init);
}

async function snapshot(id: string) {
  const raw = await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text();

  return Schema.decodeUnknownSync(Snapshot)(JSON.parse(raw));
}

const liveRun = async (id: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Live)((await snapshot(id)).docs["pi.live"]));

const userTexts = async (id: string) =>
  (await snapshot(id)).entries
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "user")
    .map((message) =>
      Schema.is(Schema.String)(message.content)
        ? message.content
        : message.content.map((block) => block.text ?? "").join("\n\n"),
    );

/** Tool failures the Agent logged as papercuts for session `id`. */
const toolPapercuts = (id: string) =>
  runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const conversationId = await state.storage.get<ConversationId>(`session:${id}`);

    return state.storage.sql
      .exec<{ source: string; message: string }>(
        "SELECT source, message FROM app_papercuts WHERE source LIKE 'tool:%' AND conversation_id = ?",
        String(conversationId),
      )
      .toArray();
  });

const queued = async (id: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))(
    (await snapshot(id)).docs["pi.inbox"] ?? { items: [] },
  ).items.length;

async function send(id: string, content: string, steer = false) {
  const sent = await post(`/api/sessions/${id}/messages`, {
    content,
    requestId: crypto.randomUUID(),
    steer,
  });

  expect(sent.status).toBe(202);

  return (await sent.json<{ submissionId: number }>()).submissionId;
}

/** A session whose model calls shell `serve` (which runs until stopped), then answers. */
async function start() {
  const created = await (await post("/api/sessions")).json<{ id: string }>();

  const conversation = await runInDurableObject(env.AGENT.getByName("owner"), (_, state) =>
    state.storage.get(`session:${created.id}`),
  );

  const container = fakeContainer({ serve: async (stopped) => 128 + (await stopped) });
  await runInDurableObject(env.SANDBOX.getByName(String(conversation)), async (instance) => {
    Object.assign(instance, { container: () => Effect.succeed(container) });
  });

  const requests: string[] = [];
  mockFetch(async (url, init) => {
    expect(String(url)).toContain("api.openai.com");
    const index = requests.push(await new Response(init?.body).text()) - 1;

    return codex(index, index === 0 ? { command: "serve" } : { text: `Answer ${index}` });
  });

  await send(created.id, "Start the server");

  // The command is running: the turn sits in its tool call.
  await expect
    .poll(async () => (await liveRun(created.id))?.tools?.length ?? 0, { timeout: 15_000 })
    .toBe(1);

  return { id: created.id, container, requests };
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

it(
  "stops the running command and answers the interrupting message next, leaving the queue",
  { timeout: 45_000 },
  async () => {
    const { id, container, requests } = await start();

    const later = await send(id, "Then run the tests");
    const first = await send(id, "Back up the database");
    const steer = await send(id, "Actually, use port 3000", true);
    const other = await send(id, "Also check the logs", true);

    // The owner moved the backup ahead of the tests.
    const reordered = await SELF.fetch(`https://worker/api/sessions/${id}/queue`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ order: [first, later] }),
    });

    expect(reordered.status).toBe(200);
    expect((await post(`/api/sessions/${id}/queue/${steer}/interrupt`)).status).toBe(202);

    // The command was killed rather than waited out, and the interrupting message went first.
    expect(container.kills).toEqual([{ command: "serve", signal: 15 }]);
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(requests[1]).toContain("Actually, use port 3000");
    expect(requests[1]).toContain(INTERRUPT_NOTE.slice(0, 60));
    expect(requests[1]).not.toContain("Then run the tests");
    expect(requests[1]).not.toContain("Back up the database");
    expect(requests[1]).not.toContain("Also check the logs");

    // The rest of the queue stayed queued in the owner's order, the other steer as a follow-up,
    // and ran after it.
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(5);
    await expect.poll(() => queued(id)).toBe(0);
    expect(requests[2]).toContain("Back up the database");
    expect(requests[3]).toContain("Then run the tests");
    expect(requests[4]).toContain("Also check the logs");

    const texts = await userTexts(id);
    expect(texts.map(stripInterruptNote)).toEqual([
      "Start the server",
      "Actually, use port 3000",
      "Back up the database",
      "Then run the tests",
      "Also check the logs",
    ]);
    // The note rides only the interrupting message, and the web app strips it.
    expect(texts[1]).toContain(INTERRUPT_NOTE);
    expect(stripInterruptNote(texts[1]!)).not.toContain("Delivery note");

    // The interrupting message is still the owner's own, as the one it replaced was: a new
    // submission joins the owner's inputs.
    const owner = await runInDurableObject(
      env.AGENT.getByName("owner"),
      async (instance, state) => {
        const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;

        return await instance["harness"].snapshot(
          OwnerInputDoc,
          conversationId,
          BACKGROUND_CONTEXT,
        );
      },
    );

    const submissions = owner?.submissions ?? [];
    expect(submissions).toEqual(expect.arrayContaining([later, first, steer, other]));
    expect(submissions).toHaveLength(6);
    expect(Math.max(...submissions)).toBeGreaterThan(other);

    // The command the interrupt killed is not a tool failure.
    expect(await toolPapercuts(id)).toEqual([]);
  },
);

it(
  "refuses to interrupt with a message that is no longer queued",
  { timeout: 45_000 },
  async () => {
    const { id, requests } = await start();
    const steer = await send(id, "Actually, use port 3000", true);

    expect((await post(`/api/sessions/${id}/queue/${steer}/interrupt`)).status).toBe(202);
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2);

    // Delivered: it has already interrupted, and can't again.
    const again = await post(`/api/sessions/${id}/queue/${steer}/interrupt`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "This message is no longer queued" });
  },
);

it("finishes an interrupt a restart cut short", { timeout: 45_000 }, async () => {
  const { id, requests } = await start();
  const steer = await send(id, "Actually, use port 3000", true);

  // The process stopped right after taking the message aside, before aborting the turn.
  await runInDurableObject(env.AGENT.getByName("owner"), async (instance, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;

    await state.storage.put(`interrupt:${conversationId}`, true);
    await instance["harness"].commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, conversationId);
      const live = await tx.doc(LiveDoc, conversationId);
      const pending = await tx.doc(InterruptDoc, conversationId);

      pending.item = inbox.items.splice(0, 1)[0];
      pending.run = { task: live.run!.taskId };
    }, BACKGROUND_CONTEXT);
  });
  expect(await queued(id)).toBe(0);

  await abortAllDurableObjects();

  // Waking up (here on a read; an alarm in production) finishes it: the message is answered next.
  await expect
    .poll(async () => (await snapshot(id)) && requests.length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  const answered = requests.findIndex((request) => request.includes("Actually, use port 3000"));
  expect(answered).toBeGreaterThan(0);
  expect(requests[answered]).toContain(INTERRUPT_NOTE.slice(0, 60));
  await expect.poll(async () => (await liveRun(id))?.run, { timeout: 15_000 }).toBeUndefined();
  expect(steer).toBeGreaterThan(0);
  // Neither the restart nor the interrupt it finished left a tool failure behind.
  expect(await toolPapercuts(id)).toEqual([]);

  const marked = await runInDurableObject(env.AGENT.getByName("owner"), (_, state) =>
    state.storage.list({ prefix: "interrupt:" }),
  );

  expect(marked.size).toBe(0);
});

it("leaves a running turn alone when a restart finds no interrupt pending", async () => {
  const { id, container, requests } = await start();

  // The process stopped after marking the conversation, before taking the message aside (or
  // after the delivery commit, before clearing the marker).
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const conversationId = (await state.storage.get<ConversationId>(`session:${id}`))!;

    await state.storage.put(`interrupt:${conversationId}`, true);
  });
  const queuedId = await send(id, "Then run the tests");

  await abortAllDurableObjects();

  // Waking clears the marker without aborting anything: the queued message is not withdrawn
  // (as a conversation abort would), and runs once the turn ends, with no interrupt note.
  await expect
    .poll(
      async () =>
        (await snapshot(id)) && requests.some((request) => request.includes("Then run the tests")),
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(requests.some((request) => request.includes(INTERRUPT_NOTE.slice(0, 60)))).toBe(false);
  expect(container.kills).toEqual([]);

  const marked = await runInDurableObject(env.AGENT.getByName("owner"), (_, state) =>
    state.storage.list({ prefix: "interrupt:" }),
  );

  expect(marked.size).toBe(0);
  expect(queuedId).toBeGreaterThan(0);

  // The restart cut the running command off ("may have partially run"): not a tool failure.
  expect(await toolPapercuts(id)).toEqual([]);
});
