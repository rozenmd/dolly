import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

it("propagates rejected workspace calls without unhandled RPC rejections", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  const config = {
    repository: "owner/project",
    ref: "main",
    branch: "pi-hard/test",
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
