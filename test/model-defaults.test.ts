import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { Live, Snapshot } from "../src/transcript";

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

/** A JSON request body: settings, a new session or a message. */
type Body = Record<string, string | boolean | null>;

const call = (path: string, method = "GET", body?: Body) =>
  SELF.fetch(`https://worker/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Listed = {
  id: string;
  model: string;
  thinkingLevel?: string;
  speed?: string;
  autoFallback?: boolean;
};

const listed = async (id: string) =>
  (await (await call("/sessions")).json<Listed[]>()).find((session) => session.id === id);

const read = async (id: string) =>
  Schema.decodeUnknownSync(Snapshot)(await (await call(`/sessions/${id}`)).json());

/** A one-line Claude answer over SSE. */
function claudeReply(text: string) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_claude",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** What ChatGPT answers once the subscription's usage limit is reached. */
const usageLimit = () =>
  Response.json(
    {
      error: {
        type: "usage_limit_reached",
        code: "subscription_sharing_usage_limit_exceeded",
        message: "subscription_sharing_usage_limit_exceeded: The usage limit has been reached",
      },
    },
    { status: 429 },
  );

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
});

afterEach(() => vi.restoreAllMocks());

it("saves default effort, speed and auto-fallback and starts new sessions with them", async () => {
  const saved = await call("/settings/model", "PUT", {
    thinkingLevel: "high",
    speed: "fast",
    autoFallback: false,
  });

  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    model: null,
    effective: "gpt-6-luna",
    thinkingLevel: "high",
    speed: "fast",
    autoFallback: false,
    ultrafastAvailable: false,
    reviewModel: null,
    reviewEffective: "gpt-6-luna",
  });

  const invalid: Body[] = [
    { speed: "turbo" },
    { thinkingLevel: "extreme" },
    { autoFallback: "yes" },
  ];

  for (const body of invalid) expect((await call("/settings/model", "PUT", body)).status).toBe(400);

  const created = await call("/sessions", "POST", {});
  expect(created.status).toBe(201);
  const session = await created.json<Listed>();
  expect(session).toMatchObject({ thinkingLevel: "high", speed: "fast", autoFallback: false });
  expect(await listed(session.id)).toMatchObject({
    thinkingLevel: "high",
    speed: "fast",
    autoFallback: false,
  });

  // Choices made in the composer override the defaults.
  const chosen = await call("/sessions", "POST", { thinkingLevel: "low", speed: "standard" });
  expect(await chosen.json()).toMatchObject({ thinkingLevel: "low", speed: "standard" });

  // An existing session changes speed and auto-fallback on its own.
  const changed = await call(`/sessions/${session.id}/settings`, "PUT", {
    speed: "standard",
    autoFallback: true,
  });

  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ speed: "standard", autoFallback: true });
  expect((await call(`/sessions/${session.id}/settings`, "PUT", { speed: "turbo" })).status).toBe(
    400,
  );
  await abortAllDurableObjects();
  expect(await listed(session.id)).toMatchObject({
    thinkingLevel: "high",
    speed: "standard",
    autoFallback: true,
  });

  // Reset each default back to the built-in one; the defaults survive restarts until then.
  expect(await (await call("/settings/model")).json()).toMatchObject({ thinkingLevel: "high" });

  const restored = await call("/settings/model", "PUT", {
    thinkingLevel: null,
    speed: null,
    autoFallback: null,
  });

  expect(await restored.json()).toEqual({
    model: null,
    effective: "gpt-6-luna",
    thinkingLevel: "medium",
    speed: "standard",
    autoFallback: true,
    ultrafastAvailable: false,
    reviewModel: null,
    reviewEffective: "gpt-6-luna",
  });
  expect(await (await call("/sessions", "POST", {})).json()).toMatchObject({
    thinkingLevel: "medium",
    speed: "standard",
    autoFallback: true,
  });
});

/** A ChatGPT access token on `plan` (opensession reads `chatgpt_plan_type` from it). */
const tokenOn = (plan?: string) =>
  `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account", ...(plan && { chatgpt_plan_type: plan }) }, exp: 9_999_999_999 })).replace(/=+$/, "")}.signature`;

it("sends ChatGPT's service tier for the session's speed, model and plan", async () => {
  const tiers: (string | undefined)[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toContain("api.openai.com/v1/responses");

    const body = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ service_tier: Schema.optional(Schema.String) })),
    )(await new Response(init?.body).text());

    tiers.push(body.service_tier);

    return Response.json({ error: { message: "Model unavailable" } }, { status: 400 });
  });

  const send = async (model: string, speed: string) => {
    const { id } = await (await call("/sessions", "POST", { model, speed })).json<{ id: string }>();
    const before = tiers.length;

    const sent = await call(`/sessions/${id}/messages`, "POST", {
      content: "hi",
      requestId: crypto.randomUUID(),
    });

    expect(sent.status).toBe(202);
    await expect.poll(() => tiers.length, { timeout: 4000 }).toBe(before + 1);

    return tiers.at(-1);
  };

  expect(await (await call("/settings/model")).json()).toMatchObject({ ultrafastAvailable: false });
  expect(await send("gpt-6-luna", "standard")).toBeUndefined();
  expect(await send("gpt-6-luna", "fast")).toBe("priority");
  // gpt-5.5's backend doesn't take the priority tier.
  expect(await send("gpt-5.5", "fast")).toBeUndefined();
  // Ultrafast needs a ChatGPT Pro login; short of it the session runs Fast.
  expect(await send("gpt-6.2-sol", "ultrafast")).toBe("priority");

  const signIn = (plan: string) =>
    runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      await state.storage.put("credential:openai", {
        type: "oauth",
        access: tokenOn(plan),
        refresh: "test-refresh",
        expires: Date.now() + 3_600_000,
      });
    });

  // Pro Lite ($100) has no Ultrafast.
  await signIn("prolite");
  expect(await (await call("/settings/model")).json()).toMatchObject({ ultrafastAvailable: false });
  expect(await send("gpt-6.2-sol", "ultrafast")).toBe("priority");

  // Both Pro plans do: $200 ("pro") and $500 ("promax").
  for (const plan of ["pro", "promax"]) {
    await signIn(plan);
    expect(await (await call("/settings/model")).json()).toMatchObject({
      ultrafastAvailable: true,
    });
    expect(await send("gpt-6.2-sol", "ultrafast")).toBe("ultrafast");
  }

  // Only Astra and Sol serve Ultrafast; Luna runs Fast.
  expect(await send("gpt-6-luna", "ultrafast")).toBe("priority");
}, 30_000);

it("keeps each session's effort to what its model accepts", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:anthropic", { type: "api_key", key: "test-claude-key" });
  });

  // Claude has no "none"; an unsupported level becomes High.
  const claude = await (
    await call("/sessions", "POST", { model: "claude-opus-5-5", thinkingLevel: "off" })
  ).json<Listed>();

  expect(claude.thinkingLevel).toBe("high");

  // GPT-6 Luna accepts none; GPT-6.2 Sol rejects it, so switching model moves it to High.
  const luna = await (
    await call("/sessions", "POST", { model: "gpt-6-luna", thinkingLevel: "off" })
  ).json<Listed>();

  expect(luna.thinkingLevel).toBe("off");

  const switched = await call(`/sessions/${luna.id}/settings`, "PUT", { model: "gpt-6.2-sol" });
  expect(await switched.json()).toEqual({ model: "gpt-6.2-sol", thinkingLevel: "high" });
  expect(await listed(luna.id)).toMatchObject({ model: "gpt-6.2-sol", thinkingLevel: "high" });

  // A saved default effort the default model doesn't take is normalized the same way.
  await call("/settings/model", "PUT", { model: "gpt-6.2-sol", thinkingLevel: "off" });
  expect(await (await call("/sessions", "POST", {})).json()).toMatchObject({
    model: "gpt-6.2-sol",
    thinkingLevel: "high",
  });
});

it("switches to the other subscription when usage runs out and finishes the turn there", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:anthropic", { type: "api_key", key: "test-claude-key" });
  });

  const hosts: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const host = new URL(String(url)).hostname;
    hosts.push(host);

    return host === "api.openai.com" ? usageLimit() : claudeReply("Finished on Claude");
  });

  const { id } = await (
    await call("/sessions", "POST", { model: "gpt-6-sol" })
  ).json<{
    id: string;
  }>();

  expect(
    (
      await call(`/sessions/${id}/messages`, "POST", {
        content: "hi",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);

  await expect
    .poll(
      async () =>
        (await read(id)).entries
          .flatMap((entry) => entry.model ?? [])
          .some((message) => message.role === "assistant" && message.stopReason === "stop"),
      { timeout: 10_000 },
    )
    .toBe(true);

  const snapshot = await read(id);
  const note = snapshot.entries.find((entry) => entry.kind === "dolly.fallback");
  // opensession's routing: Opus is the first equal-tier destination on the other subscription.
  expect(note?.data).toMatchObject({ from: "gpt-6-sol", to: "claude-opus-5-5" });
  expect(Schema.decodeUnknownSync(Live)(snapshot.docs["pi.live"]).runFailure).toBeUndefined();
  expect(hosts).toEqual(["api.openai.com", "api.anthropic.com"]);
  expect(await listed(id)).toMatchObject({ model: "claude-opus-5-5" });
}, 30_000);

it("stays on the exhausted model when auto-fallback is off, and never bounces back", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:anthropic", { type: "api_key", key: "test-claude-key" });
  });

  const hosts: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    hosts.push(new URL(String(url)).hostname);

    // Both subscriptions are out.
    return hosts.at(-1) === "api.openai.com"
      ? usageLimit()
      : Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "You've hit your session limit · resets 12:50pm (UTC)",
            },
          },
          { status: 400 },
        );
  });

  const failed = async (id: string) =>
    Schema.decodeUnknownSync(Live)((await read(id)).docs["pi.live"]).runFailure?.reason;

  const off = await (
    await call("/sessions", "POST", { model: "gpt-6-sol", autoFallback: false })
  ).json<{ id: string }>();

  await call(`/sessions/${off.id}/messages`, "POST", {
    content: "hi",
    requestId: crypto.randomUUID(),
  });
  await expect.poll(() => failed(off.id), { timeout: 4000 }).toBe("model_error");
  expect(hosts).toEqual(["api.openai.com"]);
  expect(await listed(off.id)).toMatchObject({ model: "gpt-6-sol" });

  hosts.length = 0;
  const on = await (await call("/sessions", "POST", { model: "gpt-6-sol" })).json<{ id: string }>();
  await call(`/sessions/${on.id}/messages`, "POST", {
    content: "hi",
    requestId: crypto.randomUUID(),
  });
  await expect
    .poll(() => hosts, { timeout: 10_000 })
    .toEqual(["api.openai.com", "api.anthropic.com"]);
  await expect.poll(() => failed(on.id), { timeout: 4000 }).toBe("model_error");
  // Claude ran out too, but the session fell back to it, so it doesn't switch back.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(hosts).toEqual(["api.openai.com", "api.anthropic.com"]);
  expect(await listed(on.id)).toMatchObject({ model: "claude-opus-5-5" });
}, 30_000);
