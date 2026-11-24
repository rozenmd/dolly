import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { workspaceConfig } from "../../src/workspace";

it("installs the declared Node before the setup hook and still installs dependencies when the hook fails", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  const config = workspaceConfig({ repository: "fixture/node-runtime" }, "node-runtime");

  try {
    // The image's Node is newer than this pin, so setup must fetch it from the npm registry:
    // nodejs.org is not reachable from the sandbox.
    expect(
      await sandbox.run(`set -eu
mkdir -p /workspace/repo/.agents
cd /workspace/repo
git init
printf 'v24.21.0\\n' > .nvmrc
printf '%s' '{"name":"node-runtime-fixture","private":true,"packageManager":"pnpm@10.12.1","dependencies":{"is-number":"7.0.0"}}' > package.json
printf '%s\\n' 'echo "hook saw node=$(node --version) pnpm=$(pnpm --version)" > /workspace/hook.txt' 'echo hook-failed >&2' 'exit 3' > .agents/setup
touch /workspace/ready`),
    ).toMatchObject({ exitCode: 0 });
    await runInDurableObject(sandbox, async (_, state) => {
      await state.storage.put("workspace", config);
      await state.storage.put("workspace:setup", { state: "installing", updatedAt: Date.now() });
    });
    await evictDurableObject(sandbox);
    await sandbox.prepare(config);

    const status = await sandbox.waitForDependencies();
    expect(status).toMatchObject({ state: "warning" });
    expect(status.error).toContain("Setup finished with problems:\n- .agents/setup exited 3");

    expect(
      await sandbox.run(
        `cat /workspace/hook.txt && node --version && node -e 'process.exit(require("is-number")(4) ? 0 : 1)'`,
      ),
    ).toMatchObject({
      exitCode: 0,
      stdout: "hook saw node=v24.21.0 pnpm=10.12.1\nv24.21.0\n",
    });
  } finally {
    await sandbox.restart();
  }
});
