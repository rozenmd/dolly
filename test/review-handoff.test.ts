import { createPrivateKey } from "node:crypto";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  SELF,
  createExecutionContext,
  reset,
  runInDurableObject,
  abortAllDurableObjects,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { GitHubIngress } from "../src/github-ingress";
import { ingress } from "../src/ingress";
import { ReviewHandoffs } from "../src/review-handoff";

/**
 * The review loop through the real Worker HTTP API, webhook ingress, Agent Durable Object and Pi
 * storage: a web session opens a PR, the automatic review of it runs in its own read-only
 * session, and an unsatisfied verdict comes back to the session that opened it. The model
 * provider and api.github.com are faked at fetch.
 */

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

const repository = "example/project";
const WEBHOOK_SECRET = "test-webhook-secret-at-least-32-characters";

const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

if (!("privateKey" in keys)) throw new Error("Expected an RSA key pair");

const exported = await crypto.subtle.exportKey("pkcs8", keys.privateKey);

if (!(exported instanceof ArrayBuffer)) throw new Error("Expected PKCS8 bytes");

const pkcs8 = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(exported)))}\n-----END PRIVATE KEY-----`;
const pem = createPrivateKey(pkcs8).export({ type: "pkcs1", format: "pem" }).toString();

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

const openPull = {
  operation: {
    action: "open_pull_request",
    repository,
    branch: "dolly/test",
    base: "main",
    title: "Change",
    body: "Body",
  },
};

const call = (name: string, input: typeof openPull) =>
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

const Message = Schema.Struct({ role: Schema.Literals(["user"]), content: Schema.Unknown });

/** The model's request: the latest user message, and whether a tool result came last. */
async function modelRequest(init: RequestInit | undefined) {
  const request = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ input: Schema.Array(Schema.Unknown) })),
  )(await new Response(init?.body).text());

  const users = request.input.flatMap((item) =>
    Option.toArray(Schema.decodeUnknownOption(Message)(item)),
  );

  return {
    lastUser: JSON.stringify(users.at(-1)?.content ?? ""),
    lastIsTool: Schema.is(ToolOutput)(request.input.at(-1)),
  };
}

/** What the fake GitHub API reports and records. */
type FakeGitHub = {
  /** The number the next opened pull request gets. Tests share Pi storage, so each uses its own. */
  number: number;
  /** Each pull request's current head, by number. */
  heads: Record<string, string>;
  reviews: { number: number; commit_id: string; body: string }[];
  comments: { number: number; body: string }[];
};

const github: FakeGitHub = { number: 8, heads: {}, reviews: [], comments: [] };

/** The verdicts the review model answers with, in order. */
let verdicts: string[] = [];

/** Messages the review loop delivered to the session that opened the PR. */
let handoffs: string[] = [];
let reviewPrompts: string[] = [];

function fakeGitHub(url: URL, init: RequestInit | undefined) {
  const path = url.pathname;
  const method = init?.method ?? "GET";

  if (path.endsWith("/installation")) return Response.json({ id: 7 });

  if (path.endsWith("/access_tokens"))
    return Response.json({
      token: "installation-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

  if (path === `/repos/${repository}`) return Response.json({ default_branch: "main" });

  if (path === `/repos/${repository}/pulls` && method === "POST")
    return Response.json(
      { number: github.number, html_url: `https://github.com/${repository}/pull/${github.number}` },
      { status: 201 },
    );

  const pull = path.match(/^\/repos\/example\/project\/pulls\/(\d+)$/);

  if (pull)
    return Response.json({
      state: "open",
      merged: false,
      head: { sha: github.heads[pull[1]!] ?? "a".repeat(40) },
    });

  const reviews = path.match(/^\/repos\/example\/project\/pulls\/(\d+)\/reviews$/);

  if (reviews && method === "GET") return Response.json([]);

  if (reviews) {
    const body: { commit_id: string; body: string } = JSON.parse(String(init?.body));
    github.reviews.push({ number: Number(reviews[1]), ...body });

    return Response.json({ id: 1 });
  }

  if (/^\/repos\/example\/project\/issues\/\d+\/reactions$/.test(path))
    return Response.json({ id: 1 }, { status: 201 });

  const comments = path.match(/^\/repos\/example\/project\/issues\/(\d+)\/comments$/);

  if (comments && method === "POST") {
    const body: { body: string } = JSON.parse(String(init?.body));
    github.comments.push({ number: Number(comments[1]), body: body.body });

    return Response.json({ id: 1 }, { status: 201 });
  }

  return Response.json({ message: `Unexpected ${method} ${path}` }, { status: 404 });
}

function model({ lastUser, lastIsTool }: Awaited<ReturnType<typeof modelRequest>>) {
  if (lastUser.includes("is ready for review") || lastUser.includes("has new commits")) {
    reviewPrompts.push(lastUser);

    return answer(verdicts.shift() ?? "No verdict this time");
  }

  if (lastUser.includes("[Review handoff]")) {
    handoffs.push(lastUser);

    return answer(`Handled ${handoffs.length}`);
  }

  if (lastIsTool) return answer("Opened");

  return call("github", openPull);
}

async function root() {
  const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });

  return (await response.json<{ id: string }>()).id;
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

const entry = new GitHubIngress(createExecutionContext(), env);

/** A signed pull_request webhook for PR `number` at `sha`, sent by this App's bot. */
async function pullRequestHook(action: string, number: number, sha: string) {
  const body = JSON.stringify({
    action,
    installation: { id: 7 },
    repository: { full_name: repository },
    sender: { login: "dolly-test[bot]", type: "Bot" },
    number,
    pull_request: { draft: false, head: { sha, repo: { full_name: repository } } },
  });

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  const response = await ingress.request(
    "https://ingress/hooks/github",
    {
      method: "POST",
      headers: {
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": `sha256=${Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        "X-GitHub-Delivery": crypto.randomUUID(),
      },
      body,
    },
    { INGRESS: entry },
  );

  return response.status;
}

const handoffState = () =>
  runInDurableObject(env.AGENT.getByName("owner"), async (agent) =>
    agent["harness"].snapshot(ReviewHandoffs, BACKGROUND_CONTEXT),
  );

let roots: string[] = [];

beforeEach(async () => {
  await reset();
  await signIn();
  roots = [];
  github.number = 8;
  github.heads = {};
  github.reviews = [];
  github.comments = [];
  verdicts = [];
  handoffs = [];
  reviewPrompts = [];
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 30 * 86_400_000,
    });
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "dolly-test", pem, owner: { login: "example" } },
      repositories: [repository],
    });
    await state.storage.put("github:repositories", [
      { fullName: repository, defaultBranch: "main", private: true, description: null },
    ]);
    await state.storage.put("github:accounts", ["example"]);
    await state.storage.put("github:webhook", {
      secret: WEBHOOK_SECRET,
      senders: ["trusted"],
      reviews: true,
    });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === "api.github.com") return fakeGitHub(url, init);

    return model(await modelRequest(init));
  });
});

afterEach(async () => {
  for (const id of roots)
    await SELF.fetch(`https://worker/api/sessions/${id}/abort`, {
      method: "POST",
      headers,
      body: "{}",
    });
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

/** A web session that opened PR `github.number` through the github tool. */
async function opener() {
  const id = await root();
  roots.push(id);
  await prompt(id, "Open a PR");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Opened");

  return id;
}

it("hands an unsatisfied review back to the session that opened the PR, until a review is satisfied", async () => {
  const id = await opener();
  const first = "a".repeat(40);
  const second = "b".repeat(40);

  // Round 1: the review of the opened PR finds a blocking bug.
  verdicts.push(
    "Found a null dereference in parse().\nVERDICT: blocking=1 findings=2 confidence=2",
  );
  expect(await pullRequestHook("opened", 8, first)).toBe(202);
  await expect.poll(() => handoffs, { timeout: 15_000 }).toHaveLength(1);

  // The review itself is posted without the machine-readable verdict.
  expect(github.reviews).toHaveLength(1);
  expect(github.reviews[0]!.body).toContain("Found a null dereference");
  expect(github.reviews[0]!.body).not.toContain("VERDICT");

  // The opening session gets the findings, as system context, with what to do about them.
  expect(handoffs[0]).toContain("[Review handoff]");
  expect(handoffs[0]).toContain(`${repository}#8`);
  expect(handoffs[0]).toContain("1 blocking, 2 finding(s) in total, confidence 2/5");
  expect(handoffs[0]).toContain("Fix round 1 of 6");
  expect(handoffs[0]).toContain("Found a null dereference");
  expect(handoffs[0]).not.toContain("VERDICT");
  expect(handoffs[0]).toContain("list_pull_request_comments");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Handled 1");

  // A redelivery of the same head neither reviews nor hands off again.
  expect(await pullRequestHook("reopened", 8, first)).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(reviewPrompts).toHaveLength(1);
  expect(handoffs).toHaveLength(1);

  // The session pushes a fix: the new head is reviewed again, and is now satisfied.
  github.heads["8"] = second;
  verdicts.push("The fix is right.\nVERDICT: blocking=0 findings=0 confidence=5");
  expect(await pullRequestHook("synchronize", 8, second)).toBe(202);
  await expect.poll(() => handoffs, { timeout: 15_000 }).toHaveLength(2);
  expect(reviewPrompts[1]).toContain("has new commits (pushed by @dolly-test[bot]");
  expect(handoffs[1]).toContain("is satisfied at bbbbbbb");
  expect(handoffs[1]).toContain("after 1 fix round(s)");
  expect((await handoffState())?.pulls[`${repository}#8`]).toMatchObject({
    rounds: 0,
    lastSha: second,
  });
  expect(github.comments).toEqual([]);
}, 60_000);

it("stops after the round cap with one comment on the PR, and leaves PRs no session opened alone", async () => {
  github.number = 9;
  await opener();

  // Six rounds already went by without a satisfied review.
  await runInDurableObject(env.AGENT.getByName("owner"), async (agent) => {
    await agent["harness"].commit(async (tx) => {
      (await tx.doc(ReviewHandoffs)).pulls[`${repository}#9`] = {
        rounds: 6,
        lastSha: "0".repeat(40),
      };
    }, BACKGROUND_CONTEXT);
  });

  for (const [index, sha] of ["c".repeat(40), "d".repeat(40)].entries()) {
    github.heads["9"] = sha;
    verdicts.push("Still broken.\nVERDICT: blocking=1 findings=1 confidence=1");
    expect(await pullRequestHook(index ? "synchronize" : "opened", 9, sha)).toBe(202);
    await expect.poll(() => github.reviews, { timeout: 15_000 }).toHaveLength(index + 1);
    await expect
      .poll(async () => (await handoffState())?.pulls[`${repository}#9`]?.lastSha, {
        timeout: 15_000,
      })
      .toBe(sha);
  }

  expect(handoffs).toEqual([]);
  expect(github.comments).toEqual([
    { number: 9, body: expect.stringContaining("after 6 fix rounds") },
  ]);

  // A PR nobody opened from a session is reviewed, but its findings go nowhere.
  github.heads["12"] = "e".repeat(40);
  verdicts.push("Broken.\nVERDICT: blocking=2 findings=2 confidence=1");
  expect(await pullRequestHook("opened", 12, "e".repeat(40))).toBe(202);
  await expect.poll(() => github.reviews, { timeout: 15_000 }).toHaveLength(3);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(handoffs).toEqual([]);
  expect((await handoffState())?.pulls[`${repository}#12`]).toBeUndefined();
}, 60_000);

it("doesn't hand findings to an archived session, or when the review gave no verdict", async () => {
  github.number = 10;
  const id = await opener();

  // No verdict line: the review is posted and nothing else happens.
  verdicts.push("I could not tell.");
  expect(await pullRequestHook("opened", 10, "a".repeat(40))).toBe(202);
  await expect.poll(() => github.reviews, { timeout: 15_000 }).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(handoffs).toEqual([]);

  const archived = await SELF.fetch(`https://worker/api/sessions/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ archived: true }),
  });

  expect(archived.status).toBe(200);

  github.heads["10"] = "b".repeat(40);
  verdicts.push("Broken.\nVERDICT: blocking=1 findings=1 confidence=1");
  expect(await pullRequestHook("synchronize", 10, "b".repeat(40))).toBe(202);
  await expect.poll(() => github.reviews, { timeout: 15_000 }).toHaveLength(2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(handoffs).toEqual([]);
}, 60_000);
