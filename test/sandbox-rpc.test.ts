import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { CHECKPOINT_TIMEOUT_MS, checkoutDiagnosticsScript } from "../src/workspace";
import type { Sandbox } from "../src/sandbox";

const config = {
  repository: "owner/project",
  ref: "main",
  branch: "dolly/test",
  networkHosts: [],
};

it("prepares a warm workspace only once without repeating checkout", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let checkouts = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: () =>
        Effect.sync(() => {
          checkouts++;

          return { stdout: "", stderr: "", exitCode: 0 };
        }),
    });
    expect(await instance.prepare(config)).toMatchObject({ ref: "main" });
    await instance.prepare(config);
    await instance.prepare(config);
    expect(checkouts).toBe(1);
    await instance.restart();
    await instance.prepare(config);
    expect(checkouts).toBe(2);
  });
});

it("exposes checkout stderr and permits retry after a failed setup", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let checkouts = 0;
    let diagnostics = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: (command: string) =>
        Effect.sync(() => {
          if (command === checkoutDiagnosticsScript) {
            diagnostics++;

            return { stdout: "phase: resolve_ref", stderr: "", exitCode: 0 };
          }

          return {
            stdout: "",
            stderr: checkouts++ === 0 ? "fatal: remote ref main not found" : "",
            exitCode: checkouts === 1 ? 1 : 0,
          };
        }),
    });
    let failure: unknown;

    try {
      await instance.prepare(config);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      operation: "workspace.checkout",
      message: "Git checkout failed (exit 1): fatal: remote ref main not found",
    });
    expect(diagnostics).toBe(1);
    await instance.prepare(config);
    expect(checkouts).toBe(2);
    expect(diagnostics).toBe(1);
  });
});

it("collects bounded diagnostics after a checkout timeout without masking the timeout", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    const calls: { command: string; timeout: number }[] = [];
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: (command: string, _cwd: string, timeout: number) => {
        calls.push({ command, timeout });

        return command === checkoutDiagnosticsScript
          ? Effect.fail(new Error("Diagnostic probe unavailable"))
          : Effect.never.pipe(Effect.timeout("1 millis"));
      },
    });
    await expect(instance.prepare(config)).rejects.toHaveProperty("_tag", "TimeoutError");
    expect(calls).toHaveLength(2);
    expect(calls[0].timeout).toBe(120);
    expect(calls[1]).toEqual({ command: checkoutDiagnosticsScript, timeout: 10 });
  });
});

it("preserves checkout errors even when the diagnostic probe defects", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => Effect.void,
      installDependencies: () => Effect.succeed(undefined),
      execute: (command: string) =>
        command === checkoutDiagnosticsScript
          ? Effect.die("Diagnostic process crashed")
          : Effect.succeed({
              stdout: "",
              stderr: "fatal: index.lock exists",
              exitCode: 128,
            }),
    });
    await expect(instance.prepare(config)).rejects.toMatchObject({
      operation: "workspace.checkout",
      message: "Git checkout failed (exit 128): fatal: index.lock exists",
    });
  });
});

it("propagates rejected workspace calls without unhandled RPC rejections", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  const config = {
    repository: "owner/project",
    ref: "main",
    branch: "dolly/test",
    networkHosts: [],
  };

  await runInDurableObject(sandbox, async (_, state) => {
    await state.storage.put("workspace", config);
  });
  let failure: unknown;

  try {
    await sandbox.prepare({ ...config, ref: "other" });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({ operation: "workspace.configure" });
});

it("starts setup asynchronously and makes concurrent tools join one checkout/install", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const gate = Promise.withResolvers<void>();
    let checkouts = 0;
    let installs = 0;
    let toolDone = false;
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () =>
        Effect.sync(() => {
          checkouts++;

          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      installDependencies: () =>
        Effect.tryPromise(async () => {
          installs++;
          await gate.promise;
        }),
    });
    expect(await instance.warm(config)).toEqual({ queued: true });

    const tool = instance.prepare(config).then(() => {
      toolDone = true;
    });

    try {
      await expect
        .poll(() => state.storage.get("workspace:setup"))
        .toMatchObject({ state: "installing" });
      await tool;
      expect(toolDone).toBe(true);
      expect(await instance.diagnostics()).toMatchObject({
        setup: { state: "installing" },
      });
    } finally {
      gate.resolve();
      await tool;
    }

    expect(checkouts).toBe(1);
    expect(installs).toBe(1);
    expect(toolDone).toBe(true);
    await instance.alarm();
    expect(checkouts).toBe(1);
  });
});

it("confirmed restart cancels in-flight setup instead of waiting for the install deadline", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
      installDependencies: () => Effect.never,
    });
    await instance.warm(config);
    await expect
      .poll(() => state.storage.get("workspace:setup"))
      .toMatchObject({ state: "installing" });
    await instance.restart();
    expect(await state.storage.get("workspace")).toEqual(config);
  });
});

it("reports dependency setup warnings without blocking checkout or repeating setup", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let installs = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
      installDependencies: () =>
        Effect.sync(() => {
          installs++;

          return "Package registry is unavailable";
        }),
    });
    await instance.prepare(config);
    expect(await instance.waitForDependencies()).toMatchObject({
      state: "warning",
      error: "Package registry is unavailable",
    });
    await instance.prepare(config);
    expect(installs).toBe(1);
  });
});

it("cancels dependency setup before restarting", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let installing = false;
    let cancelled = false;
    Object.assign(instance, {
      container: () => Effect.succeed({ interceptAllOutboundHttp: async () => {} }),
      execute: (command: string) =>
        command.endsWith("python3 /usr/local/lib/dolly-setup.py --once")
          ? Effect.sync(() => {
              installing = true;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cancelled = true;
                }),
              ),
            )
          : Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    });
    await instance.warm(config);
    await expect.poll(() => installing).toBe(true);
    await instance.restart();
    expect(cancelled).toBe(true);
  });
});

it("can inspect an unstarted sandbox without invoking preparation or starting a container", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => Effect.die("Diagnostics must not initialize a container"),
    });
    expect(await instance.diagnostics()).toMatchObject({ running: false });
  });
});

/** A container whose crash the test controls: stopping it discards nothing but the flag. */
function fakeContainer() {
  const starts: Parameters<Container["start"]>[0][] = [];

  const container = {
    running: true,
    images: { sandbox: "sandbox-image" },
    starts,
    start(options: Parameters<Container["start"]>[0]) {
      starts.push(options);
      container.running = true;
    },
    interceptAllOutboundHttp: async () => {},
    interceptOutboundHttps: async () => {},
    setInactivityTimeout: async () => {},
    snapshotContainer: async () => ({ id: `snapshot-${starts.length}`, size: 1 }),
  };

  return container;
}

function withContainer(
  instance: Sandbox,
  state: DurableObjectState,
  container: ReturnType<typeof fakeContainer>,
) {
  // Everything the Sandbox reads from its state after construction, plus the fake container.
  const ctx = {
    id: state.id,
    storage: state.storage,
    container,
    waitUntil: (promise: Promise<unknown>) => state.waitUntil(promise),
  };

  // The container's filesystem; a real crash is simulated only by the running flag.
  const files = new Map<string, string>();

  const fileSystem = {
    stat: async (path: string) =>
      files.has(path) ? { type: "file", size: BigInt(files.get(path)!.length) } : null,
    readFile: async (path: string) => new Response(files.get(path) ?? ""),
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    mkdir: async () => {},
  };

  Object.defineProperty(instance, "ctx", { value: ctx });
  Object.assign(instance, {
    installDependencies: () => Effect.succeed(undefined),
    execute: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    files: () => Effect.succeed(fileSystem),
  });
}

it("waits for an in-progress container snapshot before checkpointing", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const container = fakeContainer();
    withContainer(instance, state, container);
    await instance.prepare(config);
    let attempts = 0;
    container.snapshotContainer = async () => {
      attempts += 1;

      if (attempts === 1)
        throw new DOMException(
          "A snapshot is already in progress for this container. Wait for it to complete.",
          "OperationError",
        );

      return { id: "snapshot-after-conflict", size: 1 };
    };

    await expect(instance.checkpoint("turn-after-conflict")).resolves.toMatchObject({
      id: "snapshot-after-conflict",
      turnId: "turn-after-conflict",
    });
    expect(attempts).toBe(2);
  });
});

it("gives large snapshots more than two minutes and explains a timed-out save", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const container = fakeContainer();
    withContainer(instance, state, container);

    // Production saves of ~2 GB checkouts took up to ~2 minutes under load.
    expect(CHECKPOINT_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);

    await instance.prepare(config);
    await expect(instance.checkpoint("turn-1")).resolves.toMatchObject({ turnId: "turn-1" });
    const restorePoint = await state.storage.get<{ id: string }>("snapshot:checkpoint");

    await instance.run("printf work > unsaved.txt");

    // The platform snapshot stalls past the (shortened) limit and keeps running afterwards.
    Object.assign(instance, { checkpointTimeoutMs: 50 });
    let inProgress = true;
    container.snapshotContainer = async () => {
      if (inProgress)
        throw new DOMException(
          "A snapshot is already in progress for this container. Wait for it to complete.",
          "OperationError",
        );

      return { id: "snapshot-after-stall", size: 1 };
    };

    await expect(instance.checkpoint("turn-2")).rejects.toThrow(
      new RegExp(
        [
          "^Workspace save timed out: the container snapshot did not finish within 0\\.05 seconds\\.\n",
          `The restore point is the last completed save, snapshot ${restorePoint!.id} saved at \\S+ \\(end of turn turn-1\\)\\.`,
          "if that container stops first, they are discarded",
        ].join("[\\s\\S]*"),
      ),
    );

    // The old save stays the restore point and the change is still known to be unsaved.
    expect(await state.storage.get("snapshot:checkpoint")).toEqual(restorePoint);
    expect(await state.storage.get("workspace:unsaved")).toEqual(expect.any(Number));
    expect(await state.storage.get("snapshot:error")).toMatchObject({
      turnId: "turn-2",
      error: expect.stringContaining("Workspace save timed out"),
    });

    // Once the stalled snapshot finishes, the next turn-end save succeeds and clears the error.
    inProgress = false;
    await expect(instance.checkpoint("turn-3")).resolves.toMatchObject({
      id: "snapshot-after-stall",
      turnId: "turn-3",
    });
    expect(await state.storage.get("snapshot:error")).toBeUndefined();
    expect(await state.storage.get("workspace:unsaved")).toBeUndefined();
  });
});

it("tells the next repository tool, once, that a restart discarded unsaved changes", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const container = fakeContainer();
    withContainer(instance, state, container);
    await state.storage.put("workspace", config);
    await state.storage.put("snapshot:checkpoint", {
      id: "turn-end-snapshot",
      turnId: "turn-1",
      savedAt: Date.parse("2026-01-02T03:04:05Z"),
    });

    // A live container (e.g. after Durable Object eviction) lost nothing.
    expect((await instance.prepare(config)).restored).toBeUndefined();
    await instance.run("printf work > unsaved.txt");

    // The container stops mid-turn; the next tool restores the turn-end snapshot.
    container.running = false;
    const restored = (await instance.prepare(config)).restored;

    expect(container.starts).toEqual([
      expect.objectContaining({ containerSnapshot: { id: "turn-end-snapshot" } }),
    ]);
    expect(restored).toContain("WORKSPACE RESTORED");
    expect(restored).toContain("snapshot turn-end-snapshot saved at 2026-01-02T03:04:05.000Z");
    expect(restored).toContain("end of turn turn-1");
    expect(restored).toContain("git fetch origin dolly/test");

    // Reported once, not on every later tool call.
    expect((await instance.prepare(config)).restored).toBeUndefined();

    // Nothing unsaved since the restore: a later stop loses nothing and says nothing.
    container.running = false;
    expect((await instance.prepare(config)).restored).toBeUndefined();

    // Saved work is not reported as lost.
    await instance.writeFile("/workspace/repo/saved.txt", "saved");
    expect(await instance.checkpoint("turn-2")).toMatchObject({ turnId: "turn-2" });
    container.running = false;
    expect((await instance.prepare(config)).restored).toBeUndefined();

    // Reads do not count as changes; file writes do.
    await instance.readFile("/workspace/repo/saved.txt");
    container.running = false;
    expect((await instance.prepare(config)).restored).toBeUndefined();
    await instance.editFile("/workspace/repo/saved.txt", { old_string: "a", new_string: "b" });
    container.running = false;
    expect((await instance.prepare(config)).restored).toContain("WORKSPACE RESTORED");
  });
});

it("says the checkout was recreated when unsaved work is lost before any save exists", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance, state) => {
    const container = fakeContainer();
    withContainer(instance, state, container);
    await instance.prepare(config);
    await instance.run("git commit --allow-empty -m unpushed");
    container.running = false;

    const { restored } = await instance.prepare(config);

    expect(container.starts).toEqual([expect.objectContaining({ image: "sandbox-image" })]);
    expect(restored).toContain("WORKSPACE RESTARTED");
    expect(restored).toContain("recreated from main");
  });
});
