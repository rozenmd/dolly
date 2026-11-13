import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import type { Env as WorkerEnv } from "../../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

it("executes commands and uses Sandbox 1.0 Files in isolated containers", async () => {
  const first = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await first.run("printf 'sandbox proof' > proof.txt; cat proof.txt")).toMatchObject({
    stdout: "sandbox proof",
    exitCode: 0,
  });
  expect(await first.readFile("/workspace/proof.txt")).toBe("sandbox proof");
  expect(await first.run("exit 7")).toMatchObject({ exitCode: 7 });
  const environment = await first.run("env; id -u");
  expect(environment.stdout).not.toContain("API_TOKEN");
  expect(environment.stdout).not.toContain("OPENAI");
  expect(environment.stdout).toContain("1000");
  expect(await first.run("test -w /run/sandbox && test -x /run/sandbox")).toMatchObject({
    exitCode: 0,
  });
  const second = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await second.run("test ! -e /workspace/proof.txt")).toMatchObject({ exitCode: 0 });
});

it("timeout kills command descendants, reaps them, and leaves detached services running", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    await runInDurableObject(sandbox, async (instance) => {
      // Exercise the real executor with a short deadline, not a mocked timeout.
      const runtime: object = instance;

      // SAFETY: runInDurableObject supplies Sandbox; execute is TS-private, not a JS #private field.
      const executor = runtime as {
        execute(command: string, cwd: string, timeout: number): Effect.Effect<unknown, unknown>;
      };

      let failure: unknown;

      try {
        await Effect.runPromise(
          executor.execute(
            `setsid sleep 120 >/dev/null 2>&1 </dev/null &
echo $! > detached.pid
python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open("child.pid", "w").write(str(os.getpid())); time.sleep(120)' &
wait`,
            "/workspace",
            2,
          ),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toHaveProperty("_tag", "TimeoutError");
    });
    await expect
      .poll(
        async () =>
          (await sandbox.run('test ! -e /proc/$(cat child.pid) && kill -0 "$(cat detached.pid)"'))
            .exitCode,
        { timeout: 5000 },
      )
      .toBe(0);
  } finally {
    await sandbox.restart();
  }
});
