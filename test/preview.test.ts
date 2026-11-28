import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  BROWSER_PORT_HEADER,
  PREVIEW_RECORD_KEY,
  PREVIEW_TOKEN_HEADER,
  PREVIEW_TTL_MS,
  localOrigin,
  previewCookie,
  previewRequest,
  PreviewRequest,
  previewResponse,
  previewSetCookie,
  readinessHints,
} from "../src/preview";

it("pins browser routing to one hostname and strips application credentials but not its cookies", async () => {
  for (const url of ["https://scoped.test/", "http://other.test/", "http://scoped.test:3000/"])
    expect(previewRequest(new Request(url), "scoped.test")).toBeNull();

  const forwarded = previewRequest(
    new Request("http://scoped.test/page", {
      headers: {
        Cookie: "app-cookie=1; dolly-host--session=s; dolly-secure--csrf=c",
        Authorization: "Bearer app-secret",
        "CF-Access-Client-Secret": "access-secret",
        Accept: "text/html",
      },
    }),
    "scoped.test",
  );

  expect(forwarded?.url).toBe("http://scoped.test/page");

  for (const header of ["authorization", "cf-access-client-secret"])
    expect(forwarded?.headers.get(header)).toBeNull();
  expect(forwarded?.headers.get("accept")).toBe("text/html");
  // The preview host's own cookies reach the dev server under the names it set.
  expect(forwarded?.headers.get("cookie")).toBe("app-cookie=1; __Host-session=s; __Secure-csrf=c");
});

it("adapts dev-server cookies to the plain-http, single-host preview origin and back", async () => {
  expect(previewSetCookie("__Host-dolly-session=abc; Path=/; Secure; HttpOnly; SameSite=Lax")).toBe(
    "dolly-host--dolly-session=abc; Path=/; HttpOnly; SameSite=Lax",
  );
  expect(
    previewSetCookie(
      "__Secure-id=a=b; Domain=example.test; secure; SameSite=None; Partitioned; Max-Age=60",
    ),
  ).toBe("dolly-secure--id=a=b; SameSite=Lax; Max-Age=60");
  expect(previewSetCookie("theme=dark; Path=/settings")).toBe("theme=dark; Path=/settings");
  expect(previewCookie("dolly-host--dolly-session=abc;theme=dark")).toBe(
    "__Host-dolly-session=abc; theme=dark",
  );

  const headers = new Headers({ "Content-Type": "text/plain", Location: "/next" });
  headers.append("Set-Cookie", "__Host-a=1; Path=/; Secure");
  headers.append("Set-Cookie", "b=2; Domain=preview.test");
  const response = previewResponse(new Response("body", { status: 302, headers }));

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/next");
  expect(response.headers.getSetCookie()).toEqual(["dolly-host--a=1; Path=/", "b=2"]);
  expect(await response.text()).toBe("body");
  const plain = new Response("x");
  expect(previewResponse(plain)).toBe(plain);
});

it("rewrites only the page's own Origin and Referer to the dev server's origin", () => {
  const rewrite = (init: Record<string, string>) => {
    const headers = new Headers(init);
    localOrigin(headers, "http://preview-1.test", "http://localhost");

    return [headers.get("origin"), headers.get("referer")];
  };

  expect(
    rewrite({ Origin: "http://preview-1.test", Referer: "http://preview-1.test/sessions/1?a" }),
  ).toEqual(["http://localhost", "http://localhost/sessions/1?a"]);
  expect(rewrite({ Origin: "http://other.test", Referer: "http://preview-1.test.evil/" })).toEqual([
    "http://other.test",
    "http://preview-1.test.evil/",
  ]);
  expect(rewrite({ Origin: "null" })).toEqual(["null", null]);
});

it("validates action-specific preview inputs and rejects absolute/network paths", () => {
  const valid = Schema.is(PreviewRequest);
  expect(valid({ action: "start", command: "pnpm dev --host 0.0.0.0", port: 3000 })).toBe(true);

  for (const input of [
    { action: "start", port: 3000 },
    { action: "start", command: "server", port: 80 },
    { action: "start", command: "server", port: 65536 },
    { action: "screenshot", width: 10000 },
    ...["https://example.com", "//other.test", "/\\other.test", "/\nother.test"].map((path) => ({
      action: "screenshot",
      path,
    })),
  ])
    expect(valid(input)).toBe(false);
  expect(valid({ action: "screenshot", path: "/settings?tab=one", waitFor: "main" })).toBe(true);
});

it("bounds screenshot actions and scale", () => {
  const valid = Schema.is(PreviewRequest);

  expect(
    valid({
      action: "screenshot",
      scale: 2,
      actions: [
        { click: "button[aria-label='Open menu']" },
        { type: { selector: "#q", text: "hello" } },
        { press: "Enter" },
        { press: "/" },
        { waitFor: "[role=menu]" },
        { wait: 5000 },
      ],
    }),
  ).toBe(true);

  for (const input of [
    { scale: 0.5 },
    { scale: 4 },
    { actions: Array.from({ length: 11 }, () => ({ wait: 1 })) },
    { actions: [{ wait: 5001 }] },
    { actions: [{ press: "F13" }] },
    { actions: [{ press: "ab" }] },
    { actions: [{ click: "" }] },
    { actions: [{ hover: "a" }] },
    { actions: [{ type: { selector: "#q" } }] },
  ])
    expect(valid({ action: "screenshot", ...input })).toBe(false);
});

it("forwards WebSocket upgrades with their cookies but without credentials or forged sandbox capabilities", () => {
  const upgrade = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, { headers: { Upgrade: "websocket", ...headers } });

  const forwarded = previewRequest(
    upgrade("ws://scoped.test/api/sessions/1/events", {
      Cookie: "app-cookie=1",
      Authorization: "Bearer app-secret",
      [PREVIEW_TOKEN_HEADER]: "forged",
      [BROWSER_PORT_HEADER]: "22",
      "Sec-WebSocket-Protocol": "chat",
    }),
    "scoped.test",
  );

  expect(forwarded?.url).toBe("http://scoped.test/api/sessions/1/events");
  expect(forwarded?.headers.get("upgrade")).toBe("websocket");
  expect(forwarded?.headers.get("sec-websocket-protocol")).toBe("chat");

  expect(forwarded?.headers.get("cookie")).toBe("app-cookie=1");

  for (const header of ["authorization", PREVIEW_TOKEN_HEADER, BROWSER_PORT_HEADER])
    expect(forwarded?.headers.get(header)).toBeNull();
  // ws: is only an upgrade's scheme, and the hostname pin still applies.
  expect(previewRequest(new Request("ws://scoped.test/"), "scoped.test")).toBeNull();
  expect(previewRequest(upgrade("ws://other.test/"), "scoped.test")).toBeNull();
  expect(previewRequest(upgrade("wss://scoped.test/"), "scoped.test")).toBeNull();
});

it("refuses sandbox WebSocket upgrades without a live capability, without starting a container", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => {
        throw new Error("Must not start a container");
      },
    });

    const upgrade = (headers: Record<string, string>) =>
      instance.fetch(new Request("http://preview.test/ws", { headers }));

    expect((await upgrade({ [PREVIEW_TOKEN_HEADER]: "forged" })).status).toBe(404);
    expect((await upgrade({ Upgrade: "websocket", [PREVIEW_TOKEN_HEADER]: "forged" })).status).toBe(
      404,
    );
    expect((await upgrade({ Upgrade: "websocket" })).status).toBe(404);
    expect((await upgrade({ Upgrade: "websocket", [BROWSER_PORT_HEADER]: "80" })).status).toBe(404);
    // A browser port is honoured only while the workspace container already runs.
    expect((await upgrade({ Upgrade: "websocket", [BROWSER_PORT_HEADER]: "3000" })).status).toBe(
      503,
    );
  });
});

it("does not initialize a sandbox for preview status or unauthorised browser requests", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => {
        throw new Error("Must not start a container");
      },
    });
    expect(await instance.previewStatus()).toMatchObject({
      running: false,
      state: "stopped",
      message: expect.stringContaining("No preview has been started"),
    });
    expect(
      (await instance.previewFetch(new Request("http://preview.test/"), "forged")).status,
    ).toBe(404);
    await expect(instance.previewCapability()).rejects.toThrow(
      "No preview has been started in this sandbox; use preview start first",
    );
    expect(await instance.previewStop()).toEqual({ stopped: true });
  });
});

it("revokes preview capability before stopping its process without replacing workspace state", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    await state.storage.put("workspace", { repository: "owner/project" });
    const startedAt = Date.now();
    await state.storage.put(PREVIEW_RECORD_KEY, {
      port: 3000,
      startedAt,
      expiresAt: startedAt + 60_000,
    });
    let killed = 0;
    let duringKill: Promise<unknown> | undefined;
    Object.assign(instance, {
      preview: {
        token: "private",
        port: 3000,
        startedAt,
        expiresAt: startedAt + 60_000,
        exited: false,
        ready: true,
        process: {
          kill: (signal: number) => {
            killed = signal;
            duringKill = instance.previewCapability();
            void duringKill.catch(() => {});
          },
          exitCode: Promise.resolve(0),
        },
      },
    });
    await instance.previewStop();
    expect(killed).toBe(15);
    // Revoked before the kill; the reason is recorded concurrently, so only check it after.
    await expect(duringKill).rejects.toThrow("use preview start again");
    await expect(instance.previewCapability()).rejects.toThrow(
      "Preview on port 3000 was stopped at",
    );
    expect(await instance.previewStatus()).toMatchObject({
      running: false,
      message: expect.stringMatching(
        /^Preview on port 3000 was stopped at .+; use preview start again$/,
      ),
    });
    expect(await state.storage.get("workspace")).toEqual({ repository: "owner/project" });
    expect(
      (await instance.previewFetch(new Request("http://preview.test/"), "private")).status,
    ).toBe(404);
  });
});

it("explains an expired preview instead of reporting no active preview", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const startedAt = Date.now() - PREVIEW_TTL_MS - 1000;
    const expiresAt = startedAt + PREVIEW_TTL_MS;
    await state.storage.put(PREVIEW_RECORD_KEY, { port: 3000, startedAt, expiresAt });
    // The DO still holds the preview, but its 15 minutes are up.
    Object.assign(instance, {
      preview: {
        token: "private",
        port: 3000,
        startedAt,
        expiresAt,
        exited: false,
        ready: true,
        process: { kill: () => {}, exitCode: Promise.resolve(0) },
      },
    });
    await expect(instance.previewCapability()).rejects.toThrow(
      `Preview on port 3000 expired at ${new Date(expiresAt).toISOString()} (previews last 15 minutes); use preview start again`,
    );
    expect(await instance.previewStatus()).toMatchObject({
      running: false,
      message: expect.stringContaining("expired at"),
    });
  });
});

it("explains a preview lost to a sandbox restart or eviction", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const startedAt = Date.now() - 60_000;
    // Stored by a previous DO instance; this one never saw the preview.
    await state.storage.put(PREVIEW_RECORD_KEY, {
      port: 5173,
      startedAt,
      expiresAt: startedAt + PREVIEW_TTL_MS,
    });
    await expect(instance.previewCapability()).rejects.toThrow(
      `The sandbox restarted since the preview on port 5173 started at ${new Date(startedAt).toISOString()}, so it is no longer running; use preview start again`,
    );
    Object.assign(instance, {
      preview: {
        token: "private",
        port: 5173,
        startedAt,
        expiresAt: startedAt + PREVIEW_TTL_MS,
        exited: false,
        ready: true,
        process: { kill: () => {}, exitCode: Promise.resolve(0) },
      },
    });
    await instance.restart();
    await expect(instance.previewCapability()).rejects.toThrow(
      /^The sandbox restarted at .+, which ended the preview on port 5173 started at/,
    );
  });
});

it("points at the port and bind address a silent dev server logged", () => {
  expect(readinessHints("  - Local: http://localhost:5174\n", 5173)).toEqual([
    "the logs mention port 5174, not 5173: if the server picked another port, stop and start with that port",
  ]);
  expect(readinessHints("Listening on http://127.0.0.1:3000", 3000)).toEqual([
    "if the server listens on localhost only, bind it to 0.0.0.0 (for example --host 0.0.0.0 or -H 0.0.0.0)",
  ]);
  expect(readinessHints("http://localhost:3000 and http://0.0.0.0:3000", 3000)).toEqual([]);
  expect(readinessHints("compiling...", 3000)).toEqual([]);
});

it("stops the dev server even when recording why it ended fails", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const startedAt = Date.now();
    await state.storage.put(PREVIEW_RECORD_KEY, {
      port: 3000,
      startedAt,
      expiresAt: startedAt + 60_000,
    });
    let killed = 0;
    Object.assign(instance, {
      preview: {
        token: "private",
        port: 3000,
        startedAt,
        expiresAt: startedAt + 60_000,
        exited: false,
        ready: true,
        process: { kill: (signal: number) => (killed = signal), exitCode: Promise.resolve(0) },
      },
      endPreview: async () => {
        throw new Error("storage unavailable");
      },
    });
    await expect(instance.previewStop()).rejects.toThrow("storage unavailable");
    expect(killed).toBe(15);
  });
});

it("does not report a preview that ended while status probed it", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const startedAt = Date.now();
    await state.storage.put(PREVIEW_RECORD_KEY, {
      port: 3000,
      startedAt,
      expiresAt: startedAt + 60_000,
      ended: "failed",
      endedAt: startedAt,
    });

    const preview = {
      token: "private",
      port: 3000,
      startedAt,
      expiresAt: startedAt + 60_000,
      exited: false,
      ready: false,
      process: { kill: () => {}, exitCode: Promise.resolve(0) },
    };

    Object.assign(instance, {
      preview,
      livePreview: () => (preview.exited ? undefined : preview),
      // The command exits during the probe.
      previewAnswers: async () => {
        preview.exited = true;

        return false;
      },
    });
    expect(await instance.previewStatus()).toMatchObject({
      running: false,
      state: "stopped",
      message: expect.stringContaining("The last preview start on port 3000 failed"),
    });
    preview.exited = false;
    await expect(instance.previewCapability()).rejects.toThrow(
      "The last preview start on port 3000 failed",
    );
  });
});
