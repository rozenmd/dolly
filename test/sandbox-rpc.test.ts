import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import * as Effect from "effect/Effect";

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
    Object.assign(instance, {
      container: () => Effect.void,
      execute: () =>
        Effect.sync(() => ({
          stdout: "",
          stderr: checkouts++ === 0 ? "fatal: remote ref main not found" : "",
          exitCode: checkouts === 1 ? 1 : 0,
        })),
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
    await instance.prepare(config);
    expect(checkouts).toBe(2);
    expect(checkpoints).toBe(1);
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
