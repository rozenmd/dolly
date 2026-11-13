import { createPrivateKey } from "node:crypto";
import api from "../src/index";
import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GITHUB_APP_READ_PERMISSIONS } from "../src/github-permissions";
import { GitHubRequest } from "../src/github-contracts";

const headers = { Authorization: "Bearer test-token-with-at-least-32-characters" };
const repository = "example/project";
const sha = "a".repeat(40);
const setup = { owner: "example", ownerType: "organization", repositories: [repository] };

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

const der = new Uint8Array(exported);
const pkcs8 = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
const pem = createPrivateKey(pkcs8).export({ type: "pkcs1", format: "pem" }).toString();

const app = {
  id: 42,
  slug: "pi-hard-test",
  pem,
  client_id: "client-id",
  client_secret: "private-client-secret",
  webhook_secret: "private-webhook-secret-at-least-32-characters",
  owner: { login: "example" },
};

async function post<A>(path: string, body: A) {
  return SELF.fetch(`https://worker${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function start() {
  const response = await post("/api/integrations/github/setup", setup);
  const result = await response.json<{ setupUrl: string }>();

  return { url: result.setupUrl, state: result.setupUrl.split("/").at(-1) };
}

async function connect() {
  const started = await start();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(app));

  const response = await SELF.fetch(
    `https://worker/setup/github/callback?state=${started.state}&code=manifest-code`,
  );

  expect((await response.json<{ connected: boolean }>()).connected).toBe(true);
  vi.restoreAllMocks();

  return started;
}

async function execute(operation: typeof GitHubRequest.Type.operation) {
  return post("/api/integrations/github/execute", { operation });
}

beforeEach(async () => {
  await reset();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("github:connected");
    await state.storage.delete("github:pending");
    await state.storage.delete("github:webhook");
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("requires both existing API authentication gates and validates operation contracts", async () => {
  for (const path of ["/setup/github/callback", `/setup/github/${"a".repeat(43)}`])
    expect(
      (await api.request(`https://worker${path}`, {}, { ...env, ACCESS_LOCAL_DEV: "false" }))
        .status,
    ).toBe(503);

  for (const path of [
    "/api/integrations/github",
    "/api/integrations/github/setup",
    "/api/integrations/github/execute",
  ])
    expect(
      (
        await SELF.fetch(`https://worker${path}`, {
          method: path.endsWith("github") ? "GET" : "POST",
        })
      ).status,
    ).toBe(401);

  for (const operation of [
    { action: "merge_pull_request", repository },
    {
      action: "write_file",
      repository,
      branch: "main",
      path: "src/a.ts",
      message: "change",
      content: "x",
    },
    { action: "read_file", repository, path: "../secret", ref: "main" },
  ])
    expect((await post("/api/integrations/github/execute", { operation })).status).toBe(400);
});

it("keeps setup state through eviction, consumes it once and never returns credentials", async () => {
  const started = await start();
  expect(await start()).toEqual(started);
  await abortAllDurableObjects();
  const form = await SELF.fetch(started.url);
  expect(form.headers.get("Content-Security-Policy")).toContain("form-action https://github.com");
  const html = await form.text();
  expect(html).toContain("Create GitHub App");
  expect(html).toContain("/organizations/example/settings/apps/new");
  expect(html).not.toContain("private-client-secret");

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.github.com/app-manifests/manifest-code/conversions");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);

    return Response.json(app);
  });

  const callback = `https://worker/setup/github/callback?state=${started.state}&code=manifest-code`;
  const response = await SELF.fetch(callback);
  const text = await response.text();
  expect(text).toContain('"connected":true');

  for (const secret of [pem, app.client_secret, app.webhook_secret])
    expect(text).not.toContain(secret);
  expect(await (await SELF.fetch(callback)).text()).toContain("error");
  expect(fetch).toHaveBeenCalledTimes(1);
  await abortAllDurableObjects();
  expect(await (await post("/api/integrations/github/setup", setup)).json()).toMatchObject({
    connected: true,
    setupUrl: null,
  });
});

it("rejects forged, expired, and wrong-owner setup callbacks without connecting", async () => {
  const started = await start();

  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ ...app, owner: { login: "other" } }));

  expect(
    await (
      await SELF.fetch(`https://worker/setup/github/callback?state=${"x".repeat(43)}&code=bad`)
    ).text(),
  ).toContain("error");
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await (
      await SELF.fetch(
        `https://worker/setup/github/callback?state=${started.state}&code=wrong-owner`,
      )
    ).text(),
  ).toContain("does not match");
  expect(
    await (await SELF.fetch("https://worker/api/integrations/github", { headers })).json(),
  ).toEqual({ connected: false });
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const pending = await state.storage.get<{ expires: number }>("github:pending");
    await state.storage.put("github:pending", { ...pending, expires: 0, phase: "pending" });
  });
  expect(
    await (
      await SELF.fetch(`https://worker/setup/github/callback?state=${started.state}&code=expired`)
    ).text(),
  ).toContain("expired");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("mints repository-scoped tokens with a valid App signature and reads UTF-8 files", async () => {
  await connect();

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/installation")) {
      const jwt = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      const parts = jwt.split(".");

      const signature = Uint8Array.from(
        atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
        (char) => char.charCodeAt(0),
      );

      expect(
        await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          keys.publicKey,
          signature,
          new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
        ),
      ).toBe(true);

      return Response.json({ id: 7 });
    }

    if (path.endsWith("/access_tokens")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        repositories: ["project"],
        permissions: GITHUB_APP_READ_PERMISSIONS,
      });

      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    expect(path).toBe("/repos/example/project/contents/src/main.ts");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer private-installation-token",
    );

    return Response.json({
      type: "file",
      path: "src/main.ts",
      sha,
      encoding: "base64",
      content: btoa("export const answer = 42;"),
      size: 25,
    });
  });

  const operation = { action: "read_file", repository, path: "src/main.ts", ref: "main" } as const;
  const result = await (await execute(operation)).json();
  expect(result).toEqual({
    ok: true,
    result: { kind: "file", path: "src/main.ts", sha, content: "export const answer = 42;" },
  });
  expect(await (await execute(operation)).json()).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(4);
  fetch.mockImplementation(async () => Response.json({ message: "Not Found" }, { status: 404 }));
  expect(await (await execute({ ...operation, repository: "other/project" })).text()).toContain(
    "HTTP 404",
  );
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("creates only feature branches, preserves optimistic file writes, and opens but never merges PRs", async () => {
  await connect();
  const writes: string[] = [];
  let defaultBranch = "main";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

    if (path === "/repos/example/project") return Response.json({ default_branch: defaultBranch });

    if (init?.method !== "GET") writes.push(`${init?.method} ${path}`);

    if (path.endsWith("/git/ref/heads/main") || path.endsWith("/git/refs"))
      return Response.json({ object: { sha } });

    if (path.includes("/contents/")) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        branch: "pi-hard/fix",
        sha,
        content: btoa("changed"),
      });

      return Response.json({ commit: { sha } });
    }

    if (path.endsWith("/pulls"))
      return Response.json({ number: 8, html_url: "https://github.com/example/project/pull/8" });
    throw new Error(`Unexpected GitHub path ${path}`);
  });
  expect(
    await (
      await execute({ action: "create_branch", repository, base: "main", branch: "pi-hard/fix" })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "branch" } });
  expect(
    await (
      await execute({
        action: "write_file",
        repository,
        branch: "pi-hard/fix",
        path: "src/main.ts",
        sha,
        content: "changed",
        message: "Fix",
      })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "commit" } });
  expect(
    await (
      await execute({
        action: "open_pull_request",
        repository,
        branch: "pi-hard/fix",
        base: "main",
        title: "Fix",
        body: "Details",
      })
    ).json(),
  ).toMatchObject({ ok: true, result: { kind: "pull_request", number: 8 } });
  expect(
    await (
      await execute({
        action: "write_file",
        repository,
        branch: "pi-hard/fix",
        path: ".github/workflows/check.yml",
        sha,
        content: "changed",
        message: "Fix",
      })
    ).json(),
  ).toMatchObject({ ok: false, code: "workflow_denied" });
  expect(
    await (
      await execute({
        action: "write_file",
        repository,
        branch: "pi-hard/fix",
        path: "a.ts",
        sha,
        content: "漢".repeat(16_384),
        message: "Fix",
      })
    ).json(),
  ).toMatchObject({ ok: false, code: "file_too_large" });
  defaultBranch = "pi-hard/fix";
  expect(
    await (
      await execute({
        action: "write_file",
        repository,
        branch: "pi-hard/fix",
        path: "a.ts",
        sha,
        content: "change",
        message: "Fix",
      })
    ).json(),
  ).toMatchObject({ ok: false, code: "default_branch" });
  expect(writes).toEqual([
    "POST /repos/example/project/git/refs",
    "PUT /repos/example/project/contents/src/main.ts",
    "POST /repos/example/project/pulls",
  ]);
});

it("rejects expired installation tokens, bounds responses and removes credentials from fetch failures", async () => {
  await connect();
  const operation = { action: "read_file", repository, ref: "main", path: "a.ts" } as const;
  let mode = "expired";

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith("/installation")) return Response.json({ id: 7 });

    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(mode === "expired" ? 0 : Date.now() + 3_600_000).toISOString(),
      });

    if (mode === "large") return new Response("x".repeat(1_048_577));
    throw new Error(
      `Connection failed using ${new Headers(init?.headers).get("authorization")?.slice(7)}`,
    );
  });

  expect(await (await execute(operation)).text()).toContain(
    "expired or invalid installation token",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  mode = "large";
  expect(await (await execute(operation)).text()).toContain("exceeds 1 MiB");
  mode = "failure";
  const result = await (await execute(operation)).text();
  expect(result).toContain("Connection failed using [redacted]");
  expect(result).not.toContain("private-installation-token");
});

it("runs the registered github tool through Pi and persists its result without App secrets", async () => {
  await connect();
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (new URL(String(url)).pathname === "/app/installations") return Response.json([{ id: 7 }]);

    if (new URL(String(url)).pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

    if (new URL(String(url)).pathname === "/installation/repositories")
      return Response.json({ repositories: [{ full_name: repository }] });
    expect(String(url)).toContain("chatgpt.com");

    const item =
      requests++ === 0
        ? {
            type: "function_call",
            id: "fc_github",
            call_id: "call_github",
            name: "github",
            arguments: JSON.stringify({ operation: { action: "repositories" } }),
          }
        : {
            type: "message",
            id: "msg_github",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Approved repository: example/project",
                annotations: [],
              },
            ],
          };

    const events = [
      {
        type: "response.created",
        response: { id: "resp_github", status: "in_progress", output: [] },
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_github",
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
  const created = await (await post("/api/sessions", {})).json<{ id: string }>();

  try {
    expect(
      (
        await post(`/api/sessions/${created.id}/messages`, {
          content: "List approved repositories",
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(async () =>
        (await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })).text(),
      )
      .toContain("Approved repository: example/project");

    const transcript = await (
      await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })
    ).text();

    const decoded = JSON.parse(transcript);
    expect(decoded.entries).toContainEqual(
      expect.objectContaining({
        model: [
          expect.objectContaining({
            role: "toolResult",
            toolName: "github",
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  result: { kind: "repositories", repositories: [repository] },
                }),
              },
            ],
          }),
        ],
      }),
    );
    expect(transcript).not.toContain("private-client-secret");
    expect(transcript).not.toContain("PRIVATE KEY");
    expect(requests).toBe(2);
    await abortAllDurableObjects();
    expect(
      await (await SELF.fetch(`https://worker/api/sessions/${created.id}`, { headers })).text(),
    ).toContain("Approved repository: example/project");
  } finally {
    await post(`/api/sessions/${created.id}/abort`, {});
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      await state.storage.delete("credential:openai-codex");
    });
  }
});

it("enables ingress in the manifest and configures allowed senders without replacing App credentials", async () => {
  const started = await start();
  const form = await (await SELF.fetch(started.url)).text();
  expect(form).toContain("https://ingress.example/hooks/github");
  expect(form).toContain("issue_comment");
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(app));
  await SELF.fetch(
    `https://worker/setup/github/callback?state=${started.state}&code=manifest-code`,
  );
  vi.restoreAllMocks();

  let subscribed = true;

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toBe("https://api.github.com/app");

    return Response.json({
      id: 7,
      permissions: { issues: "read" },
      events: subscribed ? ["issue_comment"] : [],
    });
  });

  const configure = () =>
    SELF.fetch("https://worker/api/integrations/github/webhook", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        senders: ["trusted", ...Array.from({ length: 16 }, (_, i) => `trusted-${i}`)],
      }),
    });

  expect((await configure()).status).toBe(200);
  expect((await configure()).status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const connected = await state.storage.get<{ app: { pem: string; webhook_secret: string } }>(
      "github:connected",
    );

    expect(connected?.app.pem).toBe(pem);

    const profile = await state.storage.get<{
      secret: string;
      senders: string[];
    }>("github:webhook");

    expect(profile?.secret).toBe(app.webhook_secret);
    expect(profile?.senders).toHaveLength(17);
  });
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:connected", {
      app: { id: app.id, slug: app.slug, pem, owner: app.owner },
      repositories: [repository],
    });
    await state.storage.delete("github:webhook");
  });
  expect((await configure()).status).toBe(409);
  expect(
    (
      await SELF.fetch("https://worker/api/integrations/github/webhook", {
        method: "PUT",
        headers,
        body: JSON.stringify({ senders: ["trusted"], secret: app.webhook_secret }),
      })
    ).status,
  ).toBe(200);
  expect((await configure()).status).toBe(200);
  subscribed = false;
  expect((await configure()).status).toBe(409);
  expect(
    (
      await SELF.fetch("https://worker/api/integrations/github/webhook", {
        method: "PUT",
        body: "{}",
      })
    ).status,
  ).toBe(401);
});

it("accepts more than sixteen explicitly approved repositories", async () => {
  const repositories = Array.from({ length: 17 }, (_, i) => `example/project-${i}`);
  const response = await post("/api/integrations/github/setup", { ...setup, repositories });
  expect(response.status).toBe(200);
  const result = await response.json<{ setupUrl: string }>();
  const form = await SELF.fetch(result.setupUrl);
  expect(form.status).toBe(200);
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const pending = await state.storage.get<{ setup: { repositories: string[] } }>(
      "github:pending",
    );

    expect(pending?.setup.repositories).toEqual(repositories);
  });
  expect(
    (await post("/api/integrations/github/setup", { ...setup, repositories: [] })).status,
  ).toBe(400);
});

it("discovers repositories across App installations and paginates GitHub's repository list", async () => {
  await connect();

  const first = Array.from({ length: 100 }, (_, i) => ({
    full_name: `another-owner/project-${i}`,
  }));

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));

    if (url.pathname === "/app/installations") return Response.json([{ id: 7 }, { id: 8 }]);

    if (url.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: url.pathname.includes("/7/") ? "installation-seven" : "installation-eight",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    expect(url.pathname).toBe("/installation/repositories");

    if (url.searchParams.get("page") === "2")
      return Response.json({ repositories: [{ full_name: "third-owner/newly-granted" }] });

    return Response.json({ repositories: first });
  });

  const result = await (
    await execute({ action: "repositories" })
  ).json<{ ok: boolean; result: { repositories: string[] } }>();

  expect(result.ok).toBe(true);
  expect(result.result.repositories).toContain("another-owner/project-99");
  expect(result.result.repositories).toContain("third-owner/newly-granted");
});

it("brokers real Worker RPC Git requests without exposing credentials or allowing other branch updates", async () => {
  await connect();
  const { workspaceConfig } = await import("../src/workspace");
  const config = workspaceConfig({ repository: "another-owner/project" }, "42");
  let upstream = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));

    if (url.hostname === "github.com") {
      upstream++;
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Basic ${btoa("x-access-token:private-installation-token")}`,
      );
      expect(init?.redirect).toBe("manual");

      return new Response("Git response without credentials");
    }

    if (url.pathname.endsWith("/installation")) return Response.json({ id: 7 });

    if (url.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "private-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

    return Response.json({ default_branch: "main" });
  });
  const agent = env.AGENT.getByName("owner");

  const read = await agent.gitTransport(
    new Request(
      "http://github.workspace/another-owner/project.git/info/refs?service=git-upload-pack",
    ),
    config,
  );

  expect(await read.text()).toBe("Git response without credentials");

  for (const branch of ["main", "pi-hard/someone-else", config.branch]) {
    const command = `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/${branch}\0report-status\n`;
    const body = (command.length + 4).toString(16).padStart(4, "0") + command + "0000PACK";

    const response = await agent.gitTransport(
      new Request("http://github.workspace/another-owner/project.git/git-receive-pack", {
        method: "POST",
        body,
      }),
      config,
    );

    expect(response.status).toBe(branch === config.branch ? 200 : 403);
    await response.body?.cancel();
  }

  expect(upstream).toBe(2);
});
