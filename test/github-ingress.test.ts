import { Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { env } from "cloudflare:workers";
import {
  SELF,
  createExecutionContext,
  runInDurableObject,
  abortAllDurableObjects,
} from "cloudflare:test";
import { resetStorage } from "./storage";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GitHubThreads } from "../src/github-inbox";
import { REVIEW_INSTRUCTIONS } from "../src/review-instructions";
import { GitHubIngress } from "../src/github-ingress";
import { ingress } from "../src/ingress";
import type { SavedSession } from "../src/session-contracts";
import { headers, signIn } from "./session";
import { mockFetch } from "./titles";

const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

if (!("privateKey" in pair)) throw new Error("Expected RSA pair");

const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

if (!(exported instanceof ArrayBuffer)) throw new Error("Expected PKCS8 bytes");

const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(exported)))}\n-----END PRIVATE KEY-----`;

const secret = "test-webhook-secret-at-least-32-characters";

const payload = {
  action: "created",
  installation: { id: 7 },
  repository: { full_name: "example/project" },
  sender: { login: "trusted", type: "User" },
  issue: {
    number: 3,
    pull_request: { url: "https://api.github.com/repos/example/project/pulls/3" },
  },
  comment: { id: 123, body: "/dolly Read the README", user: { login: "trusted" } },
};

const profile = {
  secret,
  senders: ["trusted"],
  installations: [{ repository: "example/project", id: 7 }],
};

const privateEntry = new GitHubIngress(createExecutionContext(), env);

async function signature(body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));

  return (
    "sha256=" +
    Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

async function hook<A>(value: A, event = "issue_comment", suppliedSignature?: string) {
  const body = JSON.stringify(value);

  return ingress.request(
    "https://ingress/hooks/github",
    {
      method: "POST",
      headers: {
        "X-GitHub-Event": event,
        "X-Hub-Signature-256": suppliedSignature ?? (await signature(body)),
        "X-GitHub-Delivery": crypto.randomUUID(),
      },
      body,
    },
    { INGRESS: privateEntry },
  );
}

const open = Harness.open;
let harnesses: Harness[] = [];

beforeEach(async () => {
  // Before the spy: waking objects to reset them opens their harnesses.
  await resetStorage();
  harnesses = [];
  vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
    const harness = await open(...args);
    harnesses.push(harness);

    return harness;
  });
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:webhook", profile);
    await state.storage.put("github:accounts", ["example", "other"]);
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "dolly-test", pem, owner: { login: "example" } },
    });
    await state.storage.delete("credential:openai");
  });
  mockFetch(async (url) =>
    String(url).includes("/repos/other/")
      ? Response.json({}, { status: 404 })
      : Response.json({ id: 7 }),
  );
});

afterEach(async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async () => {
    await harnesses.at(-1)?.close(BACKGROUND_CONTEXT);
  });
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("exposes only the webhook POST and keeps the ordinary API protected", async () => {
  for (const [path, method] of [
    ["/api/sessions", "POST"],
    ["/api/setup/github/callback", "GET"],
    ["/hooks/github", "GET"],
    ["/other", "POST"],
  ]) {
    expect(
      (await ingress.request(`https://ingress${path}`, { method }, { INGRESS: privateEntry }))
        .status,
    ).toBe(404);
    expect(
      (await privateEntry.fetch(new Request(`https://ingress${path}`, { method }))).status,
    ).toBe(404);
  }

  expect((await SELF.fetch("https://worker/hooks/github", { method: "POST" })).status).toBe(404);
  expect((await SELF.fetch("https://worker/api/sessions", { method: "POST" })).status).toBe(401);
  expect((await hook(payload, "issue_comment", "sha256=" + "0".repeat(64))).status).toBe(401);
  expect((await SELF.fetch("https://worker/api/integrations/github/threads")).status).toBe(401);
  expect(
    (
      await ingress.request(
        "https://ingress/hooks/github",
        { method: "POST", headers: { "Content-Length": "1" }, body: "x".repeat(262_145) },
        { INGRESS: privateEntry },
      )
    ).status,
  ).toBe(413);

  expect(
    (
      await ingress.request(
        "https://ingress/hooks/github",
        { method: "POST", body: "x".repeat(262_145) },
        { INGRESS: privateEntry },
      )
    ).status,
  ).toBe(413);
});

it("validates signatures over raw bytes and rejects unauthorized installations and senders", async () => {
  const valid = await signature(JSON.stringify(payload));
  expect(
    (
      await hook(
        { ...payload, comment: { ...payload.comment, body: "/dolly changed" } },
        "issue_comment",
        valid,
      )
    ).status,
  ).toBe(401);
  expect((await hook({ ...payload, installation: { id: 8 } })).status).toBe(403);
  expect((await hook({ ...payload, repository: { full_name: "other/project" } })).status).toBe(403);
  expect((await hook({ ...payload, sender: { login: "outsider", type: "User" } })).status).toBe(
    403,
  );
  expect(
    (await hook({ ...payload, comment: { ...payload.comment, user: { login: "outsider" } } }))
      .status,
  ).toBe(403);
  expect((await hook(payload, "ping")).status).toBe(204);
  expect((await hook({ ...payload, action: "edited" })).status).toBe(204);
  expect((await hook({ ...payload, issue: { number: 3 } })).status).toBe(204);
  expect((await hook({ ...payload, sender: { login: "trusted", type: "Bot" } })).status).toBe(204);

  for (const text of [
    "please /dolly do this",
    "/dollyhello",
    "/pi Read the README",
    "/dolly",
    "/dolly " + "x".repeat(16_385),
  ])
    expect((await hook({ ...payload, comment: { ...payload.comment, body: text } })).status).toBe(
      204,
    );
  expect((await hook(payload)).status).toBe(503);
});

it("durably admits and deduplicates commands, resumes after eviction, and replies once per comment", async () => {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "dolly-test", pem, owner: { login: "example" } },
      repositories: ["example/project"],
    });
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
  const posted: string[] = [];
  const reactions: string[] = [];
  let stall = true;
  let codexRequests = 0;
  mockFetch(async (url, init) => {
    const parsed = new URL(String(url));

    if (parsed.hostname === "api.openai.com") {
      codexRequests++;

      if (stall)
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );

      const item = {
        type: "message",
        id: "msg_github",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Completed GitHub request", annotations: [] }],
      };

      const events = [
        {
          type: "response.created",
          response: { id: "resp_webhook", status: "in_progress", output: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_webhook",
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

    if (parsed.pathname.endsWith("/installation")) return Response.json({ id: 7 });

    if (parsed.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    const reaction = parsed.pathname.match(
      /^\/repos\/example\/project\/issues\/comments\/(\d+)\/reactions$/,
    );

    if (reaction) {
      expect(init?.method).toBe("POST");
      reactions.push(`${reaction[1]}:${JSON.parse(String(init?.body)).content}`);

      // GitHub fails one rocket; the posted answer must still count as delivered.
      if (reactions.at(-1) === "124:rocket") return Response.json({}, { status: 500 });

      return Response.json({ id: reactions.length }, { status: 201 });
    }

    expect([
      "/repos/example/project/issues/3/comments",
      "/repos/example/project/issues/4/comments",
    ]).toContain(parsed.pathname);

    if (init?.method === "GET")
      return Response.json(posted.map((body) => ({ body, user: { login: "dolly-test[bot]" } })));
    const body = JSON.parse(String(init?.body)).body;
    posted.push(body);

    if (posted.length === 1)
      throw new Error("Simulated lost response after GitHub saved the comment");

    return Response.json({ id: 999 });
  });

  async function threads() {
    return (await SELF.fetch("https://worker/api/integrations/github/threads", { headers })).json<
      { id: string; deliveries: { status: string; outcome: string | null }[] }[]
    >();
  }

  expect((await hook(payload)).status).toBe(202);
  // Eyes as soon as the command is admitted, before any work.
  expect(reactions).toEqual(["123:eyes"]);
  expect((await hook(payload)).status).toBe(202);
  expect(reactions).toEqual(["123:eyes"]);
  const admitted = await threads();
  expect(admitted).toHaveLength(1);
  expect(admitted[0].deliveries).toHaveLength(1);
  expect(posted).toHaveLength(0);
  await expect.poll(() => codexRequests).toBe(1);
  stall = false;
  // The test runner shares an isolate: stop the old scheduler before simulating eviction.
  expect(harnesses).toHaveLength(1);
  await runInDurableObject(env.AGENT.getByName("owner"), async () => {
    await harnesses[0].close(BACKGROUND_CONTEXT);
  });
  await abortAllDurableObjects();
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    await agent.alarm();
  });
  await expect.poll(() => posted.length).toBe(1);
  await expect.poll(async () => (await threads())[0].deliveries[0].status).toBe("sleeping");
  await runInDurableObject(env.AGENT.getByName("owner"), async () => {
    await harnesses.at(-1)?.close(BACKGROUND_CONTEXT);
  });
  await abortAllDurableObjects();
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    await agent.alarm();
  });
  await expect
    .poll(async () => (await threads())[0].deliveries[0].outcome, { timeout: 15_000 })
    .toBe("completed");
  expect(posted).toEqual([expect.stringContaining("<!-- dolly:comment:123 -->")]);
  expect(posted[0]).toContain("Completed GitHub request");
  expect(posted[0]).toContain("<!-- dolly:comment:123 -->");
  expect(reactions).toEqual(["123:eyes", "123:rocket"]);
  await runInDurableObject(env.AGENT.getByName("owner"), async () => {
    await harnesses.at(-1)?.close(BACKGROUND_CONTEXT);
  });
  await abortAllDurableObjects();
  expect((await hook(payload)).status).toBe(202);
  expect((await threads())[0].deliveries).toHaveLength(1);
  expect((await hook({ ...payload, comment: { ...payload.comment, id: 124 } })).status).toBe(202);
  await expect.poll(async () => (await threads())[0].deliveries[1].outcome).toBe("completed");
  expect((await threads())[0].id).toBe(admitted[0].id);
  expect(posted).toHaveLength(2);
  expect(reactions).toEqual(["123:eyes", "123:rocket", "124:eyes", "124:rocket"]);
  await runInDurableObject(env.AGENT.getByName("owner"), async () => {
    const harness = harnesses.at(-1);

    if (!harness) throw new Error("Expected live harness");
    await harness.commit(async (tx) => {
      const state = await tx.doc(GitHubThreads);
      const thread = state.threads["example/project#3"];
      const taskId = Object.values(thread.events)[0];

      for (let i = 0; i < 128; i++) thread.events[String(1000 + i)] = taskId;

      for (let i = 0; i < 64; i++)
        state.threads[`example/project#${1000 + i}`] = { id: thread.id, events: {} };
    }, BACKGROUND_CONTEXT);
  });
  expect((await hook({ ...payload, comment: { ...payload.comment, id: 125 } })).status).toBe(202);
  expect(
    (
      await hook({
        ...payload,
        issue: { ...payload.issue, number: 4 },
        comment: { ...payload.comment, id: 126 },
      })
    ).status,
  ).toBe(202);
  await expect.poll(() => posted.length).toBe(4);
  expect((await threads()).filter((thread) => thread.id !== admitted[0].id)).toHaveLength(1);
  expect((await hook(payload)).status).toBe(202);
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    await agent.abort(admitted[0].id);
  });
}, 25_000);

it("rejects an otherwise valid webhook from an account that is not allowed before GitHub lookup", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:accounts", []);
  });
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockClear();
  expect((await hook(payload)).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});

it("runs a /dolly command on the owner's default model, including a Claude one", async () => {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "dolly-test", pem, owner: { login: "example" } },
      repositories: ["example/project"],
    });
    // Both subscriptions connected: the saved Claude default must win over the ChatGPT one.
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
    await state.storage.put("credential:anthropic", {
      type: "api_key",
      key: `sk-ant-oat01-${"a".repeat(64)}`,
    });
  });
  const models: string[] = [];
  const posted: string[] = [];
  mockFetch(async (url, init) => {
    const parsed = new URL(String(url));

    if (parsed.hostname === "api.openai.com") {
      models.push(JSON.parse(String(init?.body)).model);

      return Response.json({ error: "ChatGPT should not run" }, { status: 500 });
    }

    if (parsed.hostname === "api.anthropic.com") {
      const model = JSON.parse(String(init?.body)).model;
      models.push(model);

      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_claude",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Answered by Opus" },
        },
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

    if (parsed.pathname.endsWith("/installation")) return Response.json({ id: 7 });

    if (parsed.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    if (parsed.pathname.endsWith("/reactions")) return Response.json({ id: 1 }, { status: 201 });

    if (parsed.pathname === "/repos/example/project/issues/5/comments") {
      if (init?.method === "GET") return Response.json([]);
      posted.push(JSON.parse(String(init?.body)).body);

      return Response.json({ id: 999 });
    }

    throw new Error(`Unexpected request to ${String(url)}`);
  });

  const saved = await SELF.fetch("https://worker/api/settings/model", {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "claude-opus-5-5" }),
  });

  expect(saved.status).toBe(200);

  // A PR and comment of its own: storage outlives earlier tests' threads.
  const command = {
    ...payload,
    issue: { ...payload.issue, number: 5 },
    comment: { ...payload.comment, id: 500 },
  };

  expect((await hook(command)).status).toBe(202);
  await expect.poll(() => posted, { timeout: 15_000 }).toHaveLength(1);
  expect(posted[0]).toContain("Answered by Opus");
  expect(models).toEqual(["claude-opus-5-5"]);
}, 25_000);

it("runs a /dolly command with only Claude connected", async () => {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:anthropic", {
      type: "api_key",
      key: `sk-ant-oat01-${"a".repeat(64)}`,
    });
  });
  // Admission no longer needs ChatGPT; the reply itself is covered above.
  expect(
    (
      await hook({
        ...payload,
        issue: { ...payload.issue, number: 6 },
        comment: { ...payload.comment, id: 600 },
      })
    ).status,
  ).toBe(202);
});

const sha = "a".repeat(40);

const pullRequest = {
  action: "opened",
  installation: { id: 7 },
  repository: { full_name: "example/project" },
  sender: { login: "trusted", type: "User" },
  number: 8,
  pull_request: {
    draft: false,
    head: { sha, repo: { full_name: "example/project" } },
  },
};

/** Delete every automation mid-test (each test starts with none: see resetStorage). */
async function clearAutomations() {
  const listed = await SELF.fetch("https://worker/api/automations", { headers });

  for (const { id } of (await listed.json<{ automations: { id: string }[] }>()).automations)
    await SELF.fetch(`https://worker/api/automations/${id}`, { method: "DELETE", headers });
}

/** A JSON request body. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const automationApi = (path: string, method: string, body?: Json) =>
  SELF.fetch(`https://worker/api/automations${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type ListedAutomation = {
  id: string;
  name: string;
  prompt: string;
  event?: string;
  enabled: boolean;
  readOnly: boolean;
  model?: string;
  runs: { trigger: string; status: string; sessionId?: string; summary?: string }[];
};

const listAutomations = async () =>
  (await (await automationApi("", "GET")).json<{ automations: ListedAutomation[] }>()).automations;

it("reviews a new pull request in an enrolled repository once, posting the answer only if the agent did not", async () => {
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    // This review runs on the ChatGPT mock, even if Claude was connected.
    await state.storage.delete("credential:anthropic");
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "dolly-test", pem, owner: { login: "example" } },
      repositories: ["example/project"],
    });
    await state.storage.put("github:repositories", [
      {
        fullName: "example/project",
        defaultBranch: "main",
        private: true,
        description: null,
      },
    ]);
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
  const prompts: string[] = [];
  const reactions: string[] = [];
  const reviews: { number: number; body: unknown }[] = [];
  const heads: Record<string, string> = {};

  // PR 9 already has the agent's own review on its head, so nothing more is posted there.
  const ownReview = [
    {
      commit_id: sha,
      user: { login: "dolly-test[bot]" },
      body: "Looks fine\n\n<!-- dolly:automatic-review -->",
    },
  ];

  mockFetch(async (url, init) => {
    const parsed = new URL(String(url));

    if (parsed.hostname === "api.openai.com") {
      prompts.push(String(init?.body));

      const item = {
        type: "message",
        id: "msg_review",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Looks good to me\n\nVERDICT: verdict=approve blocking=0 findings=0 confidence=5",
            annotations: [],
          },
        ],
      };

      const events = [
        {
          type: "response.created",
          response: { id: "resp_review", status: "in_progress", output: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_review",
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

    if (parsed.pathname.endsWith("/installation")) return Response.json({ id: 7 });

    if (parsed.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    const reaction = parsed.pathname.match(/^\/repos\/example\/project\/issues\/(\d+)\/reactions$/);

    if (reaction) {
      reactions.push(`${reaction[1]}:${JSON.parse(String(init?.body)).content}`);

      return Response.json({ id: 1 }, { status: 201 });
    }

    // The App sends pull request events, so the review automation may be enabled.
    if (parsed.pathname === "/app")
      return Response.json({ events: ["issue_comment", "pull_request"] });

    // Before a review starts, its head is checked against the pull request's current one.
    const head = parsed.pathname.match(/^\/repos\/example\/project\/pulls\/(\d+)$/);

    if (head)
      return Response.json({
        state: "open",
        head: {
          sha: heads[head[1]!] ?? sha,
          ref: "feature",
          repo: { full_name: "example/project" },
        },
      });

    // What a review reads besides the diff: the PR's description, conversation and threads.
    if (parsed.pathname === "/graphql")
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              title: "Feature",
              body: "Adds the feature flag",
              baseRefName: "main",
              author: { login: "trusted", __typename: "User" },
              comments: { nodes: [] },
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              reviews: { nodes: [] },
            },
          },
        },
      });

    const pull = parsed.pathname.match(/^\/repos\/example\/project\/pulls\/(\d+)\/reviews$/);

    if (pull) {
      if (init?.method === "GET") return Response.json(pull[1] === "9" ? ownReview : []);
      reviews.push({ number: Number(pull[1]), body: JSON.parse(String(init?.body)) });

      return Response.json({ id: 1 });
    }

    throw new Error(`Unexpected request to ${String(url)}`);
  });

  // Without a pull request automation, nothing is reviewed.
  expect((await hook(pullRequest, "pull_request")).status).toBe(204);

  // The review automation, edited: its prompt leads every review and its model runs it, not the
  // default for new sessions.
  const created = await automationApi("", "POST", {
    name: "Review pull requests",
    prompt: `Also flag every TODO left in the diff.\n\n${REVIEW_INSTRUCTIONS}`,
    event: "pull_request",
    model: "gpt-6-sol",
  });

  expect(created.status).toBe(201);
  const automation = await created.json<ListedAutomation>();
  expect(automation).toMatchObject({ event: "pull_request", enabled: true, readOnly: true });

  // Not eligible: drafts, forks, senders who may not run commands, other events and actions.
  for (const ignored of [
    { ...pullRequest, pull_request: { ...pullRequest.pull_request, draft: true } },
    {
      ...pullRequest,
      pull_request: { draft: false, head: { sha, repo: { full_name: "someone/project" } } },
    },
    { ...pullRequest, pull_request: { draft: false, head: { sha, repo: null } } },
    { ...pullRequest, sender: { login: "outsider", type: "User" } },
    { ...pullRequest, sender: { login: "trusted", type: "Bot" } },
    // Other Apps' bots are not trusted, only this App's own.
    { ...pullRequest, sender: { login: "other-app[bot]", type: "Bot" } },
    { ...pullRequest, sender: { login: "dolly-test[bot]", type: "User" } },
    { ...pullRequest, action: "edited" },
  ])
    expect((await hook(ignored, "pull_request")).status).toBe(204);
  // Repositories nobody enrolled are not reviewed.
  expect(
    (
      await hook(
        {
          ...pullRequest,
          repository: { full_name: "example/elsewhere" },
          pull_request: {
            draft: false,
            head: { sha, repo: { full_name: "example/elsewhere" } },
          },
        },
        "pull_request",
      )
    ).status,
  ).toBe(204);
  expect(reactions).toEqual([]);

  expect((await hook(pullRequest, "pull_request")).status).toBe(202);
  // The same head again (a redelivery, or reopening) is the same review.
  expect((await hook({ ...pullRequest, action: "reopened" }, "pull_request")).status).toBe(202);
  expect(reactions.filter((reaction) => reaction === "8:eyes")).toHaveLength(1);
  await expect.poll(() => reviews, { timeout: 15_000 }).toHaveLength(1);
  expect(reviews[0]).toEqual({
    number: 8,
    body: {
      commit_id: sha,
      body: expect.not.stringContaining("VERDICT"),
      event: "COMMENT",
      comments: [],
    },
  });
  expect(reviews[0]?.body).toMatchObject({ body: expect.stringContaining("Looks good to me") });
  expect(prompts).toHaveLength(1);
  // The automation's prompt, then what the review is about and how to publish it.
  expect(prompts[0]).toContain("Also flag every TODO left in the diff.");
  expect(prompts[0]).toContain("Review PR example/project#8");
  expect(prompts[0]).toContain(`(opened by @trusted, head ${sha})`);
  expect(prompts[0]).toContain("Blast radius: the worst bugs live OUTSIDE the diff");
  expect(prompts[0]).toContain("Adds the feature flag");
  expect(prompts[0]).toContain("VERDICT: verdict=");
  expect(prompts[0]).toContain(`commit_id ${sha}`);
  expect(prompts[0]).toContain("This session is read-only");
  expect(prompts[0]).toContain("MCP servers are not available in this session");

  // A review session is only offered read-only tools.
  // SAFETY: the mock above only records Responses API request bodies, whose input is an item array.
  const offered = (JSON.parse(prompts[0]).input as { type: string; tools?: { name: string }[] }[])
    .flatMap((item) => (item.type === "additional_tools" ? (item.tools ?? []) : []))
    .map((tool) => tool.name);

  expect(offered).toEqual(expect.arrayContaining(["shell", "read_file", "github", "workspace"]));

  for (const name of [
    "write_file",
    "edit_file",
    "preview",
    "spawn_task",
    "schedule_prompt",
    "mcp",
    "automations",
    "connections",
  ])
    expect(offered).not.toContain(name);

  expect(JSON.parse(prompts[0]!).model).toBe("gpt-6-sol");
  await expect.poll(() => reactions).toEqual(["8:eyes", "8:rocket"]);

  const threads = await (
    await SELF.fetch("https://worker/api/integrations/github/threads", { headers })
  ).json<{ thread: string; deliveries: { commentId: string; outcome: string | null }[] }[]>();

  expect(
    threads.find((thread) => thread.thread === `review:example/project#8@${sha}`)?.deliveries,
  ).toEqual([expect.objectContaining({ commentId: `review:${sha}`, outcome: "completed" })]);

  // The review session is read-only; a /dolly command on the same PR starts a writable session.
  const sessions = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const state = await agent["harness"].snapshot(GitHubThreads, BACKGROUND_CONTEXT);
    const reviewed = state?.threads[`review:example/project#8@${sha}`];

    if (!reviewed) throw new Error("Expected a review session");

    return {
      review: await agent["isReadOnly"](reviewed.id),
      commands: state?.threads["example/project#8"],
    };
  });

  expect(sessions).toEqual({ review: true, commands: undefined });

  // The review is a run of the automation, linked to its session, settled when its task is.
  const reviewSession = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const state = await agent["harness"].snapshot(GitHubThreads, BACKGROUND_CONTEXT);

    return String(state?.threads[`review:example/project#8@${sha}`]?.id);
  });

  await expect
    .poll(async () => (await listAutomations()).find((item) => item.id === automation.id)?.runs)
    .toEqual([
      {
        trigger: "pull_request",
        at: expect.any(Number),
        status: "succeeded",
        sessionId: reviewSession,
        summary: `example/project#8 at ${sha.slice(0, 7)}`,
      },
    ]);

  // The session list marks the automatic review, so the sidebar can leave it out.
  const listed = await (
    await SELF.fetch("https://worker/api/sessions", { headers })
  ).json<SavedSession[]>();

  const reviewId = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const state = await agent["harness"].snapshot(GitHubThreads, BACKGROUND_CONTEXT);

    return String(state?.threads[`review:example/project#8@${sha}`]?.id);
  });

  expect(listed.filter((session) => session.automation).map((session) => session.id)).toEqual([
    reviewId,
  ]);

  // A draft made ready is reviewed; the agent already published its review, so nothing is added.
  expect(
    (await hook({ ...pullRequest, action: "ready_for_review", number: 9 }, "pull_request")).status,
  ).toBe(202);
  await expect.poll(() => reactions, { timeout: 15_000 }).toContain("9:rocket");
  expect(reviews).toHaveLength(1);

  // Pull requests a Dolly session opened come from this App's own bot, and are reviewed too.
  expect(
    (
      await hook(
        { ...pullRequest, number: 11, sender: { login: "dolly-test[bot]", type: "Bot" } },
        "pull_request",
      )
    ).status,
  ).toBe(202);
  await expect.poll(() => reactions, { timeout: 15_000 }).toContain("11:rocket");
  expect(reviews.map((review) => review.number)).toEqual([8, 11]);
  expect(prompts.at(-1)).toContain("Review PR example/project#11");
  expect(prompts.at(-1)).toContain("(opened by @dolly-test[bot]");

  // A push to a pull request is reviewed again, in a fresh session of its own that starts from
  // a digest of the previous review.
  const pushed = "b".repeat(40);
  heads["8"] = pushed;

  const synchronize = {
    ...pullRequest,
    action: "synchronize",
    pull_request: {
      ...pullRequest.pull_request,
      head: { ...pullRequest.pull_request.head, sha: pushed },
    },
  };

  expect((await hook(synchronize, "pull_request")).status).toBe(202);
  await expect.poll(() => reviews, { timeout: 15_000 }).toHaveLength(3);
  expect(reviews[2]).toMatchObject({ number: 8, body: { commit_id: pushed } });
  expect(prompts.at(-1)).toContain("You previously reviewed PR example/project#8");
  expect(prompts.at(-1)).toContain("New commits have been pushed (by @trusted");
  expect(prompts.at(-1)).toContain(`You reviewed \`${sha.slice(0, 7)}\``);
  expect(prompts.at(-1)).toContain(`You last reviewed \`${sha.slice(0, 12)}\``);
  // A fresh session carries none of the earlier review's conversation.
  expect(prompts.at(-1)).not.toContain("Looks good to me");

  const sessionsByHead = await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    const state = await agent["harness"].snapshot(GitHubThreads, BACKGROUND_CONTEXT);

    return [sha, pushed].map((head) => state?.threads[`review:example/project#8@${head}`]?.id);
  });

  expect(sessionsByHead[0]).toBeDefined();
  expect(sessionsByHead[1]).toBeDefined();
  expect(sessionsByHead[0]).not.toBe(sessionsByHead[1]);

  // A push whose head has already moved on by the time its review would start is skipped.
  const promptCount = prompts.length;
  heads["8"] = "c".repeat(40);
  expect(
    (
      await hook(
        {
          ...synchronize,
          pull_request: {
            ...synchronize.pull_request,
            head: { ...synchronize.pull_request.head, sha: "d".repeat(40) },
          },
        },
        "pull_request",
      )
    ).status,
  ).toBe(202);
  await expect
    .poll(
      async () =>
        (
          await (
            await SELF.fetch("https://worker/api/integrations/github/threads", { headers })
          ).json<
            { thread: string; deliveries: { commentId: string; outcome: string | null }[] }[]
          >()
        ).find((thread) => thread.thread === `review:example/project#8@${"d".repeat(40)}`)
          ?.deliveries,
      { timeout: 15_000 },
    )
    .toContainEqual(
      expect.objectContaining({ commentId: `review:${"d".repeat(40)}`, outcome: "completed" }),
    );
  expect(prompts).toHaveLength(promptCount);
  expect(reviews).toHaveLength(3);

  // Every review is in the automation's run history, newest first.
  expect(
    (await listAutomations())
      .find((item) => item.id === automation.id)
      ?.runs.map((run) => run.summary),
  ).toEqual([
    `example/project#8 at ${"d".repeat(7)}`,
    `example/project#8 at ${pushed.slice(0, 7)}`,
    `example/project#11 at ${sha.slice(0, 7)}`,
    `example/project#9 at ${sha.slice(0, 7)}`,
    `example/project#8 at ${sha.slice(0, 7)}`,
  ]);

  // Paused, pull requests are ignored again.
  expect((await automationApi(`/${automation.id}`, "PUT", { enabled: false })).status).toBe(200);
  expect((await hook({ ...pullRequest, number: 10 }, "pull_request")).status).toBe(204);

  // Given another trigger, it keeps its reviews as finished runs, and can be run by hand.
  expect(
    (await automationApi(`/${automation.id}`, "PUT", { event: null, readOnly: false })).status,
  ).toBe(200);
  expect(
    (await listAutomations())
      .find((item) => item.id === automation.id)
      ?.runs.map((run) => run.status),
  ).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
  expect(
    (await automationApi(`/${automation.id}/run`, "POST", { requestId: crypto.randomUUID() }))
      .status,
  ).toBe(202);
}, 30_000);

it("keeps one pull request automation, and makes the old Settings > GitHub switch into it", async () => {
  let events = ["issue_comment"];

  mockFetch(async (url) =>
    new URL(String(url)).pathname === "/app" ? Response.json({ events }) : Response.json({ id: 7 }),
  );

  const review = {
    name: "Review pull requests",
    prompt: REVIEW_INSTRUCTIONS,
    event: "pull_request",
  };

  const error = async (response: Response) => (await response.json<{ error: string }>()).error;

  // Nor before the webhook is configured: every delivery would be refused.
  events = ["issue_comment", "pull_request"];
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("github:webhook");
  });

  const unconfigured = await automationApi("", "POST", review);
  expect(unconfigured.status).toBe(400);
  expect(await error(unconfigured)).toContain("Set the ingress URL");
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:webhook", profile);
  });
  events = ["issue_comment"];

  // Reviews can't be turned on while GitHub doesn't send this dolly pull request events.
  const refused = await automationApi("", "POST", review);
  expect(refused.status).toBe(400);
  expect(await error(refused)).toContain("Enable Pull request events");

  const paused = await automationApi("", "POST", { ...review, enabled: false });
  expect(paused.status).toBe(201);
  const { id } = await paused.json<ListedAutomation>();
  expect((await automationApi(`/${id}`, "PUT", { enabled: true })).status).toBe(400);
  // Editing the prompt of a paused one needs no GitHub check.
  expect((await automationApi(`/${id}`, "PUT", { prompt: "Only look for bugs." })).status).toBe(
    200,
  );

  events = ["issue_comment", "pull_request"];
  expect((await automationApi(`/${id}`, "PUT", { enabled: true })).status).toBe(200);

  // Only one automation answers pull requests, and it has no schedule, repository, MCP servers or
  // runs by hand: the review pipeline decides where and when it runs.
  const second = await automationApi("", "POST", { ...review, name: "Second", enabled: false });
  expect(second.status).toBe(400);
  expect(await error(second)).toContain(`"Review pull requests" already runs when`);

  const invalid: { [key: string]: Json }[] = [
    { schedule: "0 9 * * *" },
    { webhook: true },
    { workspace: { repository: "example/project" } },
    { mcpServers: ["sentry"] },
  ];

  for (const body of invalid) expect((await automationApi(`/${id}`, "PUT", body)).status).toBe(400);

  const run = await automationApi(`/${id}/run`, "POST", { requestId: crypto.randomUUID() });
  expect(run.status).toBe(409);
  expect(await error(run)).toContain("can't be run by hand");

  // An owner who had reviews switched on in Settings > GitHub gets the automation, enabled, on the
  // review model they had chosen, once, even at the automation limit.
  await clearAutomations();

  for (let index = 0; index < 50; index++)
    expect(
      (await automationApi("", "POST", { name: `Manual ${index}`, prompt: "Report" })).status,
    ).toBe(201);

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:webhook", { ...profile, reviews: true });
    await state.storage.put("settings:review-model", "gpt-6-sol");
    await state.storage.delete("migration:review-automation");
  });

  for (let restart = 0; restart < 2; restart++) {
    await abortAllDurableObjects();
    const listed = await listAutomations();
    expect(listed).toHaveLength(51);
    expect(listed.filter((item) => item.event)).toEqual([
      expect.objectContaining({
        name: "Review pull requests",
        prompt: REVIEW_INSTRUCTIONS,
        event: "pull_request",
        enabled: true,
        readOnly: true,
        model: "gpt-6-sol",
      }),
    ]);
  }

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    expect(await state.storage.get("settings:review-model")).toBeUndefined();
  });
}, 30_000);
