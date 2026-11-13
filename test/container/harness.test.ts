import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

it("runs the registered coding tools on another owner's repository, pushes a tested commit, opens a PR, and restores dirty work", async () => {
  const remote = env.SANDBOX.getByName(crypto.randomUUID());

  const seeded = await remote.run(`set -eu
mkdir -p remotes/another-owner
 git init --bare remotes/another-owner/project.git
 git --git-dir=remotes/another-owner/project.git config http.receivepack true
 git --git-dir=remotes/another-owner/project.git symbolic-ref HEAD refs/heads/main
 git init -b main seed
 cd seed
 git config user.name Fixture
 git config user.email fixture@example.com
 printf 'export const answer = 1;\n' > answer.mjs
 git add . && git commit -m initial
 git push ../remotes/another-owner/project.git HEAD:main`);

  expect(seeded.exitCode).toBe(0);

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

  if (!("privateKey" in pair)) throw new Error("Expected RSA keys");
  const key = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

  if (!(key instanceof ArrayBuffer)) throw new Error("Expected PKCS8 key");
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(key).toString("base64")}\n-----END PRIVATE KEY-----`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:connected", {
      app: { id: 42, slug: "fixture", pem, owner: { login: "different-app-owner" } },
    });
    await state.storage.put("credential:openai-codex", {
      type: "oauth",
      access: `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }))}.signature`,
      refresh: "fixture-refresh",
      expires: Date.now() + 3600000,
    });
  });

  const calls = [
    {
      name: "workspace",
      input: { action: "checkout", repository: "another-owner/project", ref: "main" },
    },
    {
      name: "shell",
      input: {
        command: `printf 'export const answer = 2;\n' > answer.mjs; printf "import { answer } from './answer.mjs'; if (answer !== 2) throw Error('wrong answer');\\n" > test.mjs; node --test test.mjs`,
      },
    },
    { name: "workspace", input: { action: "status" } },
    { name: "workspace", input: { action: "diff" } },
    { name: "workspace", input: { action: "commit", message: "Fix answer" } },
    { name: "workspace", input: { action: "push" } },
    {
      name: "workspace",
      input: { action: "open_pull_request", title: "Fix answer", body: "Tests passed" },
    },
  ];

  let generation = 0;
  let opened = false;

  const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));

    if (url.hostname === "chatgpt.com") {
      const call = calls[generation++];

      const item = call
        ? {
            type: "function_call",
            id: `fc_${generation}`,
            call_id: `call_${generation}`,
            name: call.name,
            arguments: JSON.stringify(call.input),
          }
        : {
            type: "message",
            id: "msg_done",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Harness workflow complete", annotations: [] }],
          };

      const events = [
        {
          type: "response.created",
          response: { id: `resp_${generation}`, status: "in_progress", output: [] },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_${generation}`,
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

    if (url.hostname === "api.github.com") {
      if (url.pathname.endsWith("/installation")) return Response.json({ id: 7 });

      if (url.pathname.endsWith("/access_tokens")) {
        expect(JSON.parse(String(init?.body)).repositories).toEqual(["project"]);

        return Response.json({
          token: "private-installation-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }

      if (url.pathname.endsWith("/pulls")) {
        opened = true;
        expect(JSON.parse(String(init?.body)).base).toBe("main");

        return Response.json({
          number: 1,
          html_url: "https://github.com/another-owner/project/pull/1",
        });
      }

      expect(url.pathname).toBe("/repos/another-owner/project");

      return Response.json({ default_branch: "main" });
    }

    expect(url.hostname).toBe("github.com");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${btoa("x-access-token:private-installation-token")}`,
    );
    const forwarded = new Request(String(input), init);
    const bytes = new Uint8Array(await forwarded.arrayBuffer());

    const result = await runInDurableObject(remote, async (_, state) => {
      const container = state.container;

      if (!container) throw new Error("Missing native container");

      const process = await container.exec(["git", "http-backend"], {
        cwd: "/workspace",
        stdin: new Blob([bytes]).stream(),
        env: {
          GIT_PROJECT_ROOT: "/workspace/remotes",
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: forwarded.method,
          CONTENT_TYPE: forwarded.headers.get("Content-Type") ?? "",
          CONTENT_LENGTH: String(bytes.length),
          REMOTE_USER: "fixture",
        },
      });

      return process.output();
    });

    expect(result.exitCode).toBe(0);
    const output = Buffer.from(result.stdout);
    const split = output.indexOf("\r\n\r\n");
    expect(split).toBeGreaterThan(0);
    const headers = new Headers();
    let status = 200;

    for (const line of output.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");

      if (colon < 0) continue;
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();

      if (name === "Status") status = Number.parseInt(value, 10);
      else headers.set(name, value);
    }

    return new Response(output.subarray(split + 4), { status, headers });
  });

  const headers = { Authorization: "Bearer test-token-with-at-least-32-characters" };

  try {
    const created = await SELF.fetch("https://worker/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: { repository: "another-owner/project", ref: "main" } }),
    });

    expect(created.status).toBe(201);
    const session = await created.json<{ id: string }>();
    expect(
      (
        await SELF.fetch(`https://worker/api/sessions/${session.id}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: "Fix the answer, run tests, commit, push and open a PR",
            requestId: crypto.randomUUID(),
          }),
        })
      ).status,
    ).toBe(202);
    await expect
      .poll(
        async () =>
          (await SELF.fetch(`https://worker/api/sessions/${session.id}`, { headers })).text(),
        { timeout: 240000 },
      )
      .toContain("Harness workflow complete");
    expect(opened).toBe(true);

    const transcript = await (
      await SELF.fetch(`https://worker/api/sessions/${session.id}`, { headers })
    ).text();

    expect(transcript).not.toContain("private-installation-token");
    const decoded = JSON.parse(transcript);

    const results = decoded.entries
      .flatMap(
        (entry: {
          model?: { role: string; isError?: boolean; content: { type: string; text?: string }[] }[];
        }) => entry.model ?? [],
      )
      .filter((message: { role: string }) => message.role === "toolResult");

    expect(results).toHaveLength(calls.length);

    for (const result of results) {
      expect(result.isError).toBe(false);

      for (const part of result.content)
        if (part.type === "text") {
          const value = JSON.parse(part.text);
          expect(value.error).toBeUndefined();

          if ("exitCode" in value) expect(value.exitCode).toBe(0);
        }
    }

    const id = await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) =>
      String(await state.storage.get(`session:${session.id}`)),
    );

    const sandbox = env.SANDBOX.getByName(id);
    expect((await sandbox.run("printf 'unsaved work' > dirty.txt")).exitCode).toBe(0);
    await sandbox.restart();
    expect((await sandbox.run("cat dirty.txt; git log -1 --format=%s")).stdout).toContain(
      "unsaved workFix answer",
    );
    expect((await sandbox.run("curl --max-time 5 https://example.com")).exitCode).not.toBe(0);

    const verification = await remote.run(
      "git --git-dir=remotes/another-owner/project.git for-each-ref --format='%(refname)' refs/heads/",
    );

    expect(verification.stdout).toContain(`refs/heads/pi-hard/session-${id}`);
    expect(
      (await remote.run("git --git-dir=remotes/another-owner/project.git show main:answer.mjs"))
        .stdout,
    ).toContain("answer = 1");
    expect((await env.WORKSPACES.list()).objects.length).toBeGreaterThan(0);
  } finally {
    mocked.mockRestore();
    await remote.restart();
  }
});
