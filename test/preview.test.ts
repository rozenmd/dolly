import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  PREVIEW_RECORD_KEY,
  PREVIEW_TTL_MS,
  previewRequest,
  PreviewRequest,
  readinessHints,
} from "../src/preview";

it("pins browser routing to one hostname and strips application credentials", async () => {
  for (const url of ["https://scoped.test/", "http://other.test/", "http://scoped.test:3000/"])
    expect(previewRequest(new Request(url), "scoped.test")).toBeNull();

  const forwarded = previewRequest(
    new Request("http://scoped.test/page", {
      headers: {
        Cookie: "app-cookie",
        Authorization: "Bearer app-secret",
        "CF-Access-Client-Secret": "access-secret",
        Accept: "text/html",
      },
    }),
    "scoped.test",
  );

  expect(forwarded?.url).toBe("http://scoped.test/page");

  for (const header of ["cookie", "authorization", "cf-access-client-secret"])
    expect(forwarded?.headers.get(header)).toBeNull();
  expect(forwarded?.headers.get("accept")).toBe("text/html");
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
