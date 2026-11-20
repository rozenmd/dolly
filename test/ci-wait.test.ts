import { createPrivateKey } from "node:crypto";
import { env } from "cloudflare:workers";
import {
  SELF,
  createExecutionContext,
  reset,
  runInDurableObject,
  runDurableObjectAlarm,
  abortAllDurableObjects,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { GitHubIngress } from "../src/github-ingress";
import { ingress } from "../src/ingress";

/**
 * Durable CI waits through the real Worker HTTP API, Agent Durable Object, Pi storage and alarms.
 * The model provider and api.github.com are faked at fetch; the clock is advanced with Date.now.
 */

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

const repository = "example/project";

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

type WaitArguments = {
  kind?: string;
  repository?: string;
  number?: number;
  run_id?: number;
  workflow?: string;
  ref?: string;
  prompt?: string;
  timeout_minutes?: number;
};

const call = (name: string, input: WaitArguments | typeof openPull) =>
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

const Message = Schema.Struct({
  role: Schema.Literals(["user"]),
  content: Schema.Unknown,
});

/** The model's request: the latest user message and tool output. */
async function modelRequest(init: RequestInit | undefined) {
  const request = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ input: Schema.Array(Schema.Unknown) })),
  )(await new Response(init?.body).text());

  const outputs = request.input.flatMap((item) =>
    Option.toArray(Schema.decodeUnknownOption(ToolOutput)(item)),
  );

  const users = request.input.flatMap((item) =>
    Option.toArray(Schema.decodeUnknownOption(Message)(item)),
  );

  return {
    lastUser: JSON.stringify(users.at(-1)?.content ?? ""),
    toolOutput: outputs.at(-1)?.output,
    lastIsTool: Schema.is(ToolOutput)(request.input.at(-1)),
  };
}

type Check = { name: string; status: string; conclusion: string | null };

type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  jobs: {
    name: string;
    status: string;
    conclusion: string | null;
    steps?: { name: string; conclusion: string | null }[];
  }[];
};

/** What the fake GitHub API currently reports. */
type FakeGitHub = {
  pull: { state: string; merged: boolean; sha: string };
  checks: Check[];
  run?: Run;
  /** Every API read, then the full PR reads and the cheap GraphQL count reads on their own. */
  reads: number;
  pulls: number;
  graphql: number;
  /** Pull requests opened through the API. */
  opened: number;
};

const github: FakeGitHub = {
  pull: { state: "open", merged: false, sha: "a".repeat(40) },
  checks: [],
  reads: 0,
  pulls: 0,
  graphql: 0,
  opened: 0,
};

/** The GraphQL rollup state GitHub would count a fake check under. */
function rollupState(check: Check) {
  if (check.status !== "completed") return "IN_PROGRESS";

  return (check.conclusion ?? "").toUpperCase();
}

/** The fake model's reply to a request; `undefined` falls through to the default. */
let model: (request: Awaited<ReturnType<typeof modelRequest>>) => Response;
let modelCalls = 0;

function fakeGitHub(url: URL) {
  const path = url.pathname;

  if (path.endsWith("/installation")) return Response.json({ id: 7 });

  if (path.endsWith("/access_tokens"))
    return Response.json({
      token: "installation-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

  github.reads += 1;

  if (path === "/graphql") {
    github.graphql += 1;
    const counts = new Map<string, number>();

    for (const check of github.checks)
      counts.set(rollupState(check), (counts.get(rollupState(check)) ?? 0) + 1);

    return Response.json({
      data: {
        repository: {
          pullRequest: {
            state: github.pull.merged ? "MERGED" : github.pull.state.toUpperCase(),
            headRefOid: github.pull.sha,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        checkRunCountsByState: [...counts].map(([state, count]) => ({
                          state,
                          count,
                        })),
                        statusContextCountsByState: [],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
  }

  if (path === `/repos/${repository}`) return Response.json({ default_branch: "main" });

  if (path === `/repos/${repository}/pulls`) {
    github.opened += 1;

    return Response.json(
      { number: 8, html_url: `https://github.com/${repository}/pull/8` },
      { status: 201 },
    );
  }

  if (path === `/repos/${repository}/pulls/8`) github.pulls += 1;

  if (path === `/repos/${repository}/pulls/8`)
    return Response.json({
      state: github.pull.state,
      merged: github.pull.merged,
      head: { sha: github.pull.sha },
    });

  if (path === `/repos/${repository}/pulls/404`)
    return Response.json({ message: "Not Found" }, { status: 404 });

  if (path.endsWith("/check-runs"))
    return Response.json({
      check_runs: github.checks.map((check) => ({
        ...check,
        details_url: `https://ci.example/${check.name}`,
      })),
    });

  if (path.endsWith("/status")) return Response.json({ state: "pending", statuses: [] });

  if (path.endsWith("/actions/workflows/release.yml/runs"))
    return Response.json({ workflow_runs: github.run ? [runBody(github.run)] : [] });

  if (github.run && path.endsWith(`/actions/runs/${github.run.id}`))
    return Response.json(runBody(github.run));

  if (github.run && path.endsWith(`/actions/runs/${github.run.id}/jobs`))
    return Response.json({ jobs: github.run.jobs });

  return Response.json({ message: `Unexpected ${path}` }, { status: 500 });
}

const runBody = (run: Run) => ({
  id: run.id,
  name: "Release",
  status: run.status,
  conclusion: run.conclusion,
  html_url: `https://github.com/${repository}/actions/runs/${run.id}`,
  head_sha: "b".repeat(40),
  run_attempt: 1,
});

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

const WEBHOOK_SECRET = "test-webhook-secret-at-least-32-characters";
const entry = new GitHubIngress(createExecutionContext(), env);

/** The event-specific part of a fake CI webhook payload; installation and repository are added. */
type WebhookPayload = {
  action?: string;
  number?: number;
  pull_request?: { merged: boolean; head: { sha: string } };
  sha?: string;
  state?: string;
  check_run?: { head_sha: string; conclusion: string | null; pull_requests: { number: number }[] };
  check_suite?: { head_sha: string; pull_requests: { number: number }[] };
  workflow_run?: {
    id: number;
    head_sha: string;
    head_branch: string;
    path: string;
    pull_requests: { number: number }[];
  };
};

/** Deliver a signed GitHub webhook through the ingress Worker, as GitHub would. */
async function webhook(event: string, payload: WebhookPayload) {
  const body = JSON.stringify({
    installation: { id: 7 },
    repository: { full_name: repository },
    ...payload,
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
        "X-GitHub-Event": event,
        "X-Hub-Signature-256": `sha256=${Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
        "X-GitHub-Delivery": crypto.randomUUID(),
      },
      body,
    },
    { INGRESS: entry },
  );

  return response.status;
}

const wait = async (id: string) =>
  (
    await (
      await SELF.fetch(`https://worker/api/sessions/${id}/wait`, { headers })
    ).json<{
      wait: { id: string; waiting_on: string; next_poll: string; last_seen?: string } | null;
    }>()
  ).wait;

const realNow = Date.now.bind(Date);
const started = { at: 0 };

/** Set the clock `ms` after the test started, evict the Agent and fire its alarm. */
async function at(ms: number) {
  await abortAllDurableObjects();
  vi.spyOn(Date, "now").mockImplementation(() => started.at + ms);
  await runDurableObjectAlarm(env.AGENT.getByName("owner"));
  // The poll's GitHub read and commit finish after the alarm handler returns.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const alarm = () =>
  runInDurableObject(env.AGENT.getByName("owner"), (_, state) => state.storage.getAlarm());

beforeEach(async () => {
  await reset();
  await signIn();
  roots = [];
  started.at = realNow();
  github.pull = { state: "open", merged: false, sha: "a".repeat(40) };
  github.checks = [];
  github.run = undefined;
  github.reads = 0;
  github.pulls = 0;
  github.graphql = 0;
  github.opened = 0;
  modelCalls = 0;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      // Outlives the advanced test clock, so no OAuth refresh is attempted.
      expires: Date.now() + 30 * 86_400_000,
    });
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "dolly-test", pem, owner: { login: "example" } },
    });
    await state.storage.put("github:accounts", ["example"]);
    await state.storage.put("github:webhook", { secret: WEBHOOK_SECRET, senders: [] });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === "api.github.com") return fakeGitHub(url);
    modelCalls += 1;

    return model(await modelRequest(init));
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

const pending = (name: string): Check => ({ name, status: "in_progress", conclusion: null });

const done = (name: string, conclusion: string): Check => ({
  name,
  status: "completed",
  conclusion,
});

/** A model that registers `wait` on the first prompt and reports whatever wakes it. */
function waiter(wait: WaitArguments) {
  const wakes: string[] = [];
  const outputs: string[] = [];

  model = ({ lastUser, toolOutput, lastIsTool }) => {
    if (lastIsTool && toolOutput) {
      outputs.push(toolOutput);

      return answer(`Registered: ${toolOutput}`);
    }

    if (lastUser.includes("[CI wait ")) {
      wakes.push(lastUser);

      return answer(`Woken ${wakes.length}`);
    }

    return call("wait_for", wait);
  };

  return { wakes, outputs };
}

it("wakes the session on the first failed check, without the model running between polls", async () => {
  github.checks = [pending("lint"), pending("test")];
  const { wakes, outputs } = waiter({ kind: "pr_checks", repository, number: 8 });

  const id = await root();
  await prompt(id, "Push and wait for CI");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Registered: ");
  expect(outputs[0]).toContain("0 passed, 0 failed, 2 pending of 2");
  expect(outputs[0]).toContain("End your turn now");
  const afterTurn = modelCalls;

  // The turn has ended and the next alarm is the first poll, ~15s out: nothing keeps the
  // Durable Object busy in between.
  expect(await alarm()).toBeLessThanOrEqual(realNow() + 16_000);

  // Checks still running: several polls read GitHub, nothing is delivered, no model runs.
  const reads = github.reads;
  await at(20_000);
  expect(github.pulls).toBe(2);

  // While checks plainly run, the next poll is one 1-point GraphQL count read, not the full read.
  await at(55_000);
  expect(github.graphql).toBe(1);
  expect(github.pulls).toBe(2);
  expect(github.reads).toBeGreaterThan(reads);
  expect(await userEntries(id)).toBe(1);
  expect(modelCalls).toBe(afterTurn);

  // A failed check is final for its commit: it wakes the agent while "test" still runs, once the
  // result has held for the settle window.
  // The count read sees the failure and falls through to the full read, which names it.
  github.checks = [done("lint", "failure"), pending("test")];
  await at(90_000);
  expect(github.graphql).toBe(2);
  expect(github.pulls).toBe(3);
  expect(wakes).toHaveLength(0);
  await at(125_000);
  await at(160_000);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(1);
  expect(wakes[0]).toContain("failed · PR #8: 1 failed, 1 still running");
  expect(wakes[0]).toContain("lint (https://ci.example/lint)");
  expect(wakes[0]).toContain("This is system context, not a message from the user.");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Woken 1");
  expect(await userEntries(id)).toBe(2);

  // Delivered exactly once: later alarms deliver nothing more.
  await at(400_000);
  expect(wakes).toHaveLength(1);
});

it("doesn't wake a re-armed wait for results it already reported, but does once they change", async () => {
  github.checks = [done("lint", "success"), done("test", "success")];
  const { wakes } = waiter({ kind: "pr_checks", repository, number: 8 });

  const id = await root();
  await prompt(id, "Wait for CI");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Registered: ");

  for (const ms of [20_000, 55_000, 90_000]) await at(ms);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(1);
  expect(wakes[0]).toContain("passed · PR #8: checks passed");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Woken 1");

  // Re-arm on the same PR with nothing changed: no second wake.
  await prompt(id, "Wait again");
  await expect
    .poll(async () => (await transcript(id)).split("Registered: ").length, { timeout: 10_000 })
    .toBe(3);

  for (const ms of [120_000, 160_000, 300_000, 450_000]) await at(ms);
  expect(wakes).toHaveLength(1);

  // Unchanged results are re-read every 2 minutes, and the alarm sits there: the Durable Object
  // isn't kept on the 60s heartbeat of an active turn while it waits.
  expect(await alarm()).toBeGreaterThan(started.at + 450_000 + 60_000);

  // A new push changes the head: it wakes again once its checks settle.
  github.pull.sha = "c".repeat(40);

  for (const ms of [600_000, 640_000, 680_000]) await at(ms);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(2);
  expect(wakes[1]).toContain("on ccccccc");
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

it("opening a pull request subscribes the session to its checks, unasked", async () => {
  github.checks = [pending("lint"), pending("test")];
  const wakes: string[] = [];
  const outputs: string[] = [];

  model = ({ lastUser, toolOutput, lastIsTool }) => {
    if (lastIsTool && toolOutput) {
      outputs.push(toolOutput);

      return answer("Opened");
    }

    if (lastUser.includes("[CI wait ")) {
      wakes.push(lastUser);

      return answer(`Woken ${wakes.length}`);
    }

    return call("github", openPull);
  };

  const id = await root();
  await prompt(id, "Open a PR");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Opened");
  expect(github.opened).toBe(1);
  expect(outputs[0]).toContain('"ciWait"');
  expect(outputs[0]).toContain(`${repository}#8 checks`);
  expect((await wait(id))?.waiting_on).toBe(`${repository}#8 checks`);

  github.checks = [done("lint", "failure"), pending("test")];

  for (const ms of [20_000, 55_000, 90_000, 125_000]) await at(ms);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(1);
  expect(wakes[0]).toContain("failed · PR #8");
  expect(wakes[0]).toContain("This is the pull request you opened in this session.");
});

it("opening a pull request leaves an explicit wait in place", async () => {
  github.run = { id: 99, status: "in_progress", conclusion: null, jobs: [] };
  const outputs: string[] = [];
  let step = 0;

  model = ({ lastIsTool, toolOutput }) => {
    if (lastIsTool && toolOutput) outputs.push(toolOutput);
    step += 1;

    if (step === 1) return call("wait_for", { kind: "workflow_run", repository, run_id: 99 });

    if (step === 2) return call("github", openPull);

    return answer("Done");
  };

  const id = await root();
  await prompt(id, "Wait for the run, then open a PR");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Done");
  expect(github.opened).toBe(1);
  expect(outputs[1]).not.toContain('"ciWait"');
  expect((await wait(id))?.waiting_on).toBe(`${repository} Actions run 99`);
});

it("watches a workflow run named by workflow and ref before it exists", async () => {
  const { wakes, outputs } = waiter({
    kind: "workflow_run",
    repository,
    workflow: "release.yml",
    ref: "v1.2.0",
    prompt: "Check the release published",
  });

  const id = await root();
  await prompt(id, "Tag and wait for the release");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Registered: ");
  expect(outputs[0]).toContain("no matching run yet");

  await at(20_000);
  github.run = {
    id: 99,
    status: "in_progress",
    conclusion: null,
    jobs: [{ name: "build", status: "in_progress", conclusion: null }],
  };
  await at(70_000);
  expect(wakes).toHaveLength(0);

  github.run = {
    id: 99,
    status: "completed",
    conclusion: "failure",
    jobs: [
      {
        name: "publish",
        status: "completed",
        conclusion: "failure",
        steps: [
          { name: "Checkout", conclusion: "success" },
          { name: "npm publish", conclusion: "failure" },
        ],
      },
    ],
  };
  await at(120_000);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(1);
  expect(wakes[0]).toContain("failed · Release failure");
  expect(wakes[0]).toContain("publish [failed step: npm publish]");
  expect(wakes[0]).toContain("Check the release published");
});

it("wakes when the PR merges, and at the timeout when checks never settle", async () => {
  github.checks = [pending("slow")];
  const { wakes } = waiter({ kind: "pr_checks", repository, number: 8, timeout_minutes: 5 });

  const id = await root();
  await prompt(id, "Wait");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Registered: ");

  for (const ms of [20_000, 60_000, 120_000, 240_000]) await at(ms);
  expect(wakes).toHaveLength(0);
  await at(301_000);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(1);
  expect(wakes[0]).toContain("timed_out · timed out on example/project#8 checks");
  expect(wakes[0]).toContain("Last seen: 0 passed, 0 failed, 1 pending of 1");

  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Woken 1");
  github.pull = { state: "closed", merged: true, sha: "a".repeat(40) };
  await prompt(id, "Wait again");
  await expect
    .poll(async () => (await transcript(id)).split("Registered: ").length, { timeout: 10_000 })
    .toBe(3);
  await at(330_000);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(2);
  expect(wakes[1]).toContain("closed · PR #8 is merged");
}, 20_000);

it("cancel_wait stops delivery, and bad targets fail in the turn", async () => {
  github.checks = [done("lint", "failure")];
  const outputs: string[] = [];
  let woken = false;

  const steps: [string, WaitArguments][] = [
    ["wait_for", { kind: "pr_checks", repository }],
    ["wait_for", { kind: "pr_checks", repository: "not a repo", number: 8 }],
    ["wait_for", { kind: "pr_checks", repository, number: 404 }],
    ["wait_for", { kind: "workflow_run", repository, workflow: "release.yml" }],
    ["wait_for", { kind: "pr_checks", repository, number: 8 }],
    ["cancel_wait", {}],
    ["cancel_wait", {}],
  ];

  model = ({ lastUser, toolOutput, lastIsTool }) => {
    if (lastUser.includes("[CI wait ")) woken = true;

    if (lastIsTool && toolOutput) outputs.push(toolOutput);
    const next = steps[outputs.length];

    return next && !woken ? call(...next) : answer("Done");
  };

  const id = await root();
  await prompt(id, "Try waits");
  await expect.poll(() => outputs.length, { timeout: 4000 }).toBe(steps.length);

  expect(outputs).toEqual([
    expect.stringContaining("pr_checks needs number"),
    expect.stringContaining("repository must be owner/name"),
    expect.stringContaining("Could not read example/project#404 checks"),
    expect.stringContaining("workflow_run needs run_id, or workflow"),
    expect.stringContaining('"waiting_on":"example/project#8 checks"'),
    expect.stringContaining('"state":"cancelled"'),
    expect.stringContaining("No CI wait is active"),
  ]);

  for (const ms of [20_000, 60_000, 120_000]) await at(ms);
  expect(woken).toBe(false);
  expect(await userEntries(id)).toBe(1);
});

it("a matching webhook pulls the next poll forward; others don't", async () => {
  github.checks = [pending("lint")];
  const { wakes } = waiter({ kind: "pr_checks", repository, number: 8 });

  const id = await root();
  await prompt(id, "Wait for CI");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Registered: ");
  await at(20_000);
  const before = await wait(id);
  expect(before?.last_seen).toContain("1 pending of 1");
  expect(Date.parse(before?.next_poll ?? "")).toBe(started.at + 50_000);
  const pulls = github.pulls;

  // Events for another PR and commit, a passing check run, or a pending status: no nudge.
  expect(
    await webhook("check_suite", {
      action: "completed",
      check_suite: { head_sha: "d".repeat(40), pull_requests: [{ number: 9 }] },
    }),
  ).toBe(202);
  expect(
    await webhook("check_run", {
      action: "completed",
      check_run: { head_sha: "a".repeat(40), conclusion: "success", pull_requests: [] },
    }),
  ).toBe(204);
  expect(await webhook("status", { sha: "a".repeat(40), state: "pending" })).toBe(204);
  expect(github.pulls).toBe(pulls);
  expect((await wait(id))?.id).toBe(before?.id);

  // A failing check on the head the wait last saw: it reads GitHub now, at the same clock time,
  // without waiting for the alarm. The settle window still applies before it wakes the agent.
  github.checks = [done("lint", "failure")];
  expect(
    await webhook("check_run", {
      action: "completed",
      check_run: { head_sha: "a".repeat(40), conclusion: "failure", pull_requests: [] },
    }),
  ).toBe(202);
  await expect.poll(() => github.pulls, { timeout: 4000 }).toBe(pulls + 1);
  const nudged = await wait(id);
  expect(nudged?.id).not.toBe(before?.id);
  expect(Date.parse(nudged?.next_poll ?? "")).toBe(started.at + 20_000 + 30_000);

  await at(50_000);
  await at(80_000);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(1);
  expect(wakes[0]).toContain("failed · PR #8: 1 of 1 checks failed");
  expect(await wait(id)).toBeNull();
  expect(
    await webhook("check_suite", {
      action: "completed",
      check_suite: { head_sha: "a".repeat(40), pull_requests: [{ number: 8 }] },
    }),
  ).toBe(202);
  expect(wakes).toHaveLength(1);
});

/** The sidebar's change feed, as the web app opens it. */
async function sidebarFeed() {
  const response = await SELF.fetch("https://worker/api/events", {
    headers: { ...headers, Upgrade: "websocket", Origin: "https://worker" },
  });

  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const messages: string[] = [];
  socket.addEventListener("message", (event) => messages.push(String(event.data)));
  socket.accept();

  return { socket, messages };
}

it("the sidebar feed announces runs starting and ending, and archiving", async () => {
  model = () => answer("Done");

  const id = await root();
  const feed = await sidebarFeed();

  const running = async () =>
    (
      await (
        await SELF.fetch("https://worker/api/sessions", { headers })
      ).json<{ id: string; running?: boolean; archived?: boolean }[]>()
    ).find((session) => session.id === id);

  await prompt(id, "Hello");
  await expect.poll(() => transcript(id)).toContain("Done");
  await expect.poll(async () => (await running())?.running).toBe(false);
  // Restoring the session on prompt, the run starting and the run ending.
  await expect.poll(() => feed.messages.length, { timeout: 4000 }).toBeGreaterThanOrEqual(3);

  // Let the turn's trailing work (titling, checkpoints) finish announcing itself first.
  let before = -1;

  while (before !== feed.messages.length) {
    before = feed.messages.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const archived = await SELF.fetch(`https://worker/api/sessions/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ archived: true }),
  });

  expect(archived.status).toBe(200);
  await expect.poll(() => feed.messages.length).toBeGreaterThan(before);
  expect(new Set(feed.messages)).toEqual(new Set(['{"type":"sessions"}']));
  feed.socket.close();
});

it("a pull_request webhook updates the sidebar's PR state before the cache expires", async () => {
  model = ({ lastIsTool, lastUser }) => {
    if (lastIsTool) return answer("Opened");

    if (lastUser.includes("[CI wait ")) return answer("Woken");

    return call("github", openPull);
  };

  const id = await root();
  await prompt(id, "Open a PR");
  await expect.poll(() => transcript(id)).toContain("Opened");

  const state = async () => {
    const sessions = await (
      await SELF.fetch("https://worker/api/sessions", { headers })
    ).json<{ id: string; pullRequest?: { number: number; state?: string } }[]>();

    return sessions.find((session) => session.id === id)?.pullRequest;
  };

  // The first list reads GitHub in the background; a later one shows what it found.
  await expect.poll(state, { timeout: 4000 }).toMatchObject({ number: 8, state: "open" });

  const feed = await sidebarFeed();
  await expect.poll(() => feed.messages.length).toBe(0);

  // Merged on GitHub, well inside the 60 second cache: only the webhook can tell the sidebar.
  github.pull = { state: "closed", merged: true, sha: "a".repeat(40) };
  expect(
    await webhook("pull_request", {
      action: "closed",
      number: 8,
      pull_request: { merged: true, head: { sha: "a".repeat(40) } },
    }),
  ).toBe(202);
  // The feed announces it once the new state is stored, so the very next list shows it.
  await expect.poll(() => feed.messages.length, { timeout: 4000 }).toBeGreaterThan(0);
  expect(feed.messages).toContain('{"type":"sessions"}');
  expect((await state())?.state).toBe("merged");
  feed.socket.close();

  // A PR no session shows is not read at all.
  const after = github.reads;
  expect(
    await webhook("pull_request", {
      action: "closed",
      number: 9,
      pull_request: { merged: true, head: { sha: "e".repeat(40) } },
    }),
  ).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(github.reads).toBe(after);
});

it("a workflow_run webhook wakes a release wait at once, without an alarm", async () => {
  const { wakes } = waiter({
    kind: "workflow_run",
    repository,
    workflow: "release.yml",
    ref: "v1.2.0",
  });

  const id = await root();
  await prompt(id, "Tag and wait");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Registered: ");

  github.run = {
    id: 77,
    status: "completed",
    conclusion: "success",
    jobs: [{ name: "publish", status: "completed", conclusion: "success" }],
  };

  expect(
    await webhook("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 77,
        head_sha: "b".repeat(40),
        head_branch: "v1.2.0",
        path: ".github/workflows/release.yml",
        pull_requests: [],
      },
    }),
  ).toBe(202);
  await expect.poll(() => wakes.length, { timeout: 4000 }).toBe(1);
  expect(wakes[0]).toContain("passed · Release success");
});

it("shows the session's wait to the owner and lets them cancel it", async () => {
  github.checks = [pending("lint")];
  const { wakes } = waiter({ kind: "pr_checks", repository, number: 8 });

  const id = await root();
  expect(await wait(id)).toBeNull();
  await prompt(id, "Wait for CI");
  await expect.poll(() => transcript(id), { timeout: 10_000 }).toContain("Registered: ");
  expect(await wait(id)).toMatchObject({ waiting_on: "example/project#8 checks" });

  const cancelled = await SELF.fetch(`https://worker/api/sessions/${id}/wait`, {
    method: "DELETE",
    headers,
  });

  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ state: "cancelled" });
  expect(await wait(id)).toBeNull();

  const again = await SELF.fetch(`https://worker/api/sessions/${id}/wait`, {
    method: "DELETE",
    headers,
  });

  expect(again.status).toBe(404);

  github.checks = [done("lint", "failure")];

  for (const ms of [20_000, 60_000, 120_000]) await at(ms);
  expect(wakes).toHaveLength(0);
});
