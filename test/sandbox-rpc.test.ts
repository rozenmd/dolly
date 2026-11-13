import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { checkoutDiagnosticsScript } from "../src/workspace";

const config = {
  repository: "owner/project",
  ref: "main",
  branch: "dolly/test",
  networkHosts: [],
};

it("prepares a warm workspace only once without repeating checkout or checkpoints", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let checkouts = 0;
    let checkpoints = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () =>
        Effect.sync(() => {
          checkouts++;

          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      checkpoint: () =>
        Effect.sync(() => {
          checkpoints++;
        }),
    });
    expect(await instance.prepare(config)).toMatchObject({ ref: "main" });
    await instance.prepare(config);
    await instance.prepare(config);
    expect(checkouts).toBe(1);
    expect(checkpoints).toBe(1);
    await instance.restart();
    await instance.prepare(config);
    expect(checkouts).toBe(2);
    expect(checkpoints).toBe(2);
  });
});

it("exposes checkout stderr and permits retry after a failed setup", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let checkouts = 0;
    let checkpoints = 0;
    let diagnostics = 0;
    Object.assign(instance, {
      container: () => Effect.void,
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
      checkpoint: () =>
        Effect.sync(() => {
          checkpoints++;
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
    expect(checkpoints).toBe(0);
    expect(diagnostics).toBe(1);
    await instance.prepare(config);
    expect(checkouts).toBe(2);
    expect(checkpoints).toBe(1);
    expect(diagnostics).toBe(1);
  });
});

it("collects bounded diagnostics after a checkout timeout without masking the timeout", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    const calls: { command: string; timeout: number }[] = [];
    let checkpoints = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      execute: (command: string, _cwd: string, timeout: number) => {
        calls.push({ command, timeout });

        return command === checkoutDiagnosticsScript
          ? Effect.fail(new Error("Diagnostic probe unavailable"))
          : Effect.never.pipe(Effect.timeout("1 millis"));
      },
      checkpoint: () =>
        Effect.sync(() => {
          checkpoints++;
        }),
    });
    await expect(instance.prepare(config)).rejects.toHaveProperty("_tag", "TimeoutError");
    expect(calls).toHaveLength(2);
    expect(calls[0].timeout).toBe(120);
    expect(calls[1]).toEqual({ command: checkoutDiagnosticsScript, timeout: 10 });
    expect(checkpoints).toBe(0);
  });
});

it("preserves checkout errors even when the diagnostic probe defects", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, {
      container: () => Effect.void,
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

it("does not cache preparation until its initial checkpoint succeeds", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  await runInDurableObject(sandbox, async (instance) => {
    let checkpoints = 0;
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
      checkpoint: () =>
        Effect.suspend(() =>
          checkpoints++ === 0 ? Effect.fail(new Error("Checkpoint unavailable")) : Effect.void,
        ),
    });
    let failure: unknown;

    try {
      await instance.prepare(config);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ message: "Checkpoint unavailable" });
    await instance.prepare(config);
    await instance.prepare(config);
    expect(checkpoints).toBe(2);
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
