import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Env as WorkerEnv } from "../../src/env";

declare global { namespace Cloudflare { interface Env extends WorkerEnv {} } }

it("executes commands and uses Sandbox 1.0 Files in isolated native containers", async () => {
  const first = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await first.run("printf 'sandbox proof' > proof.txt; cat proof.txt")).toMatchObject({ stdout: "sandbox proof", exitCode: 0 });
  expect(await first.readFile("/workspace/proof.txt")).toBe("sandbox proof");
  expect(await first.run("exit 7")).toMatchObject({ exitCode: 7 });
  const environment = await first.run("env; id -u");
  expect(environment.stdout).not.toContain("API_TOKEN");
  expect(environment.stdout).not.toContain("OPENAI");
  expect(environment.stdout).toContain("1000");
  const second = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await second.run("test ! -e /workspace/proof.txt")).toMatchObject({ exitCode: 0 });
});
