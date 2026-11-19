import { env } from "cloudflare:workers";
import {
  SELF,
  reset,
  runInDurableObject,
  runDurableObjectAlarm,
  abortAllDurableObjects,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { SlackThreads } from "../src/slack-inbox";

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

const answer = (text: string) =>
  sse({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });

/** Arguments of a schedule tool call the fake model makes. */
type ToolArguments = { prompt?: string; in_minutes?: number; at?: string; id?: string };

const call = (name: string, input: ToolArguments) =>
  sse({
    type: "function_call",
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(input),
  });

const ToolOutput = Schema.Struct({
  type: Schema.Literals(["function_call_output"]),
  output: Schema.String,
});

/** The model's request: its serialized input and the latest tool output, if any. */
async function modelRequest(init: RequestInit | undefined) {
  const request = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ input: Schema.Array(Schema.Unknown) })),
  )(await new Response(init?.body).text());

  const outputs = request.input.flatMap((item) =>
    Option.toArray(Schema.decodeUnknownOption(ToolOutput)(item)),
  );

  return { serialized: JSON.stringify(request.input), toolOutput: outputs.at(-1)?.output };
}

let roots: string[] = [];

async function root() {
  const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await response.json<{ id: string }>();
  roots.push(id);

  return id;
}

async function prompt(id: string, content: string) {
  const response = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content, requestId: crypto.randomUUID() }),
  });

  expect(response.status).toBe(202);
}

const transcript = async (id: string) =>
  (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text();

const userEntries = async (id: string) =>
  (
    await (
      await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })
    ).json<{
      entries: { kind: string }[];
    }>()
  ).entries.filter((entry) => entry.kind === "pi.user").length;

const realNow = Date.now.bind(Date);

/** Move the shared isolate's clock `ms` past real time and fire the Agent's alarm. */
async function advance(ms: number) {
  const now = realNow();
  vi.spyOn(Date, "now").mockImplementation(() => now + ms);
  await runDurableObjectAlarm(env.AGENT.getByName("owner"));
}

beforeEach(async () => {
  await reset();
  await signIn();
  roots = [];
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      // Outlives the advanced test clock, so no OAuth refresh is attempted.
      expires: Date.now() + 30 * 86_400_000,
    });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();

  for (const id of roots)
    await SELF.fetch(`https://worker/api/sessions/${id}/abort`, {
      method: "POST",
      headers,
      body: "{}",
    });
  await abortAllDurableObjects();
});

it("delivers a scheduled prompt into the same session after the delay, across eviction", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const { serialized, toolOutput } = await modelRequest(init);

    if (serialized.includes("[Scheduled prompt ")) return answer("Ran the scheduled work");

    if (toolOutput) return answer(`Scheduled: ${toolOutput}`);

    return call("schedule_prompt", { in_minutes: 120, prompt: "Start the migration now" });
  });

  const id = await root();
  await prompt(id, "In two hours, start the migration");
  await expect.poll(() => transcript(id)).toContain("Scheduled: ");
  const before = await transcript(id);
  expect(before).toMatch(/\\"id\\":\\"[^"\\]+\\",\\"at\\":/);
  expect(before).not.toContain("Ran the scheduled work");

  // Nothing is delivered before the time, even when the alarm fires early.
  await abortAllDurableObjects();
  await advance(60 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await userEntries(id)).toBe(1);

  await abortAllDurableObjects();
  await advance(121 * 60_000);
  await expect.poll(() => transcript(id), { timeout: 4000 }).toContain("Ran the scheduled work");
  expect(await transcript(id)).toContain("Start the migration now");
  expect(await userEntries(id)).toBe(2);
});

it("cancels a scheduled prompt by id so it never arrives", async () => {
  let delivered = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const { serialized, toolOutput } = await modelRequest(init);

    if (serialized.includes("[Scheduled prompt ")) {
      delivered = true;

      return answer("Should not run");
    }

    if (!toolOutput) return call("schedule_prompt", { in_minutes: 5, prompt: "Later" });

    if (toolOutput.includes('"state":"cancelled"')) return answer(`Cancelled: ${toolOutput}`);

    const scheduled = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
    )(toolOutput);

    return call("cancel_scheduled_prompt", { id: scheduled.id });
  });

  const id = await root();
  await prompt(id, "Remind me in five minutes, then cancel it");
  await expect.poll(() => transcript(id)).toContain("Cancelled: ");

  await advance(10 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(delivered).toBe(false);
  expect(await userEntries(id)).toBe(1);
});

it("rejects ambiguous or out-of-range times without scheduling", async () => {
  const outputs: string[] = [];

  const attempts = [
    {},
    { in_minutes: 5, at: "2030-01-01T00:00:00Z" },
    { at: "2030-01-01T09:00:00" },
    { at: new Date(Date.now() - 60_000).toISOString() },
  ];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const { toolOutput } = await modelRequest(init);

    if (toolOutput) outputs.push(toolOutput);
    const next = attempts[outputs.length];

    if (next) return call("schedule_prompt", { prompt: "Later", ...next });

    return outputs.length === attempts.length ? call("list_scheduled_prompts", {}) : answer("Done");
  });

  const id = await root();
  await prompt(id, "Schedule badly");
  await expect.poll(() => outputs.length, { timeout: 4000 }).toBeGreaterThan(attempts.length);

  expect(outputs.slice(0, attempts.length)).toEqual([
    expect.stringContaining("Give exactly one of in_minutes or at"),
    expect.stringContaining("Give exactly one of in_minutes or at"),
    expect.stringContaining("ISO 8601 time with an offset"),
    expect.stringContaining("at least 1 minute ahead"),
  ]);
  expect(outputs[attempts.length]).toContain('"scheduled":[]');
});

it("stopping the session cancels its pending scheduled prompts", async () => {
  let delivered = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const { serialized, toolOutput } = await modelRequest(init);

    if (serialized.includes("[Scheduled prompt ")) {
      delivered = true;

      return answer("Should not run");
    }

    if (toolOutput) return answer(`Scheduled: ${toolOutput}`);

    return call("schedule_prompt", { in_minutes: 5, prompt: "Later" });
  });

  const id = await root();
  await prompt(id, "Do it in five minutes");
  await expect.poll(() => transcript(id)).toContain("Scheduled: ");

  const stopped = await SELF.fetch(`https://worker/api/sessions/${id}/abort`, {
    method: "POST",
    headers,
    body: "{}",
  });

  expect(stopped.status).toBe(200);
  await advance(10 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(delivered).toBe(false);
  expect(await userEntries(id)).toBe(1);
});

it("refuses to schedule from a Slack intake thread, whose text is not only the owner's", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    const { toolOutput } = await modelRequest(init);

    if (toolOutput) return answer(`Result: ${toolOutput}`);

    return call("schedule_prompt", { in_minutes: 5, prompt: "Later" });
  });

  const id = await root();

  // Mark this conversation as a Slack intake thread, as slack-inbox.ts does on creation.
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent, state) => {
    const conversationId = await state.storage.get<ConversationId>(`session:${id}`);

    if (conversationId === undefined) throw new Error("Session alias missing");

    await agent["harness"].commit(async (tx) => {
      const threads = await tx.doc(SlackThreads);
      threads.threads["C1:1.0"] = { id: conversationId, events: {} };
    }, BACKGROUND_CONTEXT);
  });

  await prompt(id, "Do it in five minutes");
  await expect.poll(() => transcript(id)).toContain("Result: ");
  expect(await transcript(id)).toContain("only available in sessions started from the web app");
});
