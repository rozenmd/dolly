import { Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { env } from "cloudflare:workers";
import {
  SELF,
  createExecutionContext,
  runInDurableObject,
  reset,
  abortAllDurableObjects,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubThreads } from "../src/github-inbox";
import { GitHubIngress } from "../src/github-ingress";
import { ingress } from "../src/ingress";
import { headers, signIn } from "./session";

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
  comment: { id: 123, body: "/pi Read the README", user: { login: "trusted" } },
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
  harnesses = [];
  vi.spyOn(Harness, "open").mockImplementation(async (...args) => {
    const harness = await open(...args);
    harnesses.push(harness);

    return harness;
  });
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:webhook", profile);
    await state.storage.put("github:accounts", ["example", "other"]);
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "dolly-test", pem, owner: { login: "example" } },
    });
    await state.storage.delete("credential:openai-codex");
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
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
        { ...payload, comment: { ...payload.comment, body: "/pi changed" } },
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

  for (const text of ["please /pi do this", "/pilot hello", "/pi", "/pi " + "x".repeat(16_385)])
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
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
  const posted: string[] = [];
  let stall = true;
  let codexRequests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const parsed = new URL(String(url));

    if (parsed.hostname === "chatgpt.com") {
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
  expect((await hook(payload)).status).toBe(202);
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
