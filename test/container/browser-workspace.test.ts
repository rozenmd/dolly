import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import type { WorkspaceOutbound } from "../../src/git-transport";
import { workspaceConfig } from "../../src/workspace";

it("reaches the Browser Run broker from inside the container without credentials", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  const workspace = workspaceConfig(
    { repository: `fixture/browser-${crypto.randomUUID()}` },
    "browser",
  );

  try {
    await sandbox.run("true");
    await runInDurableObject(sandbox, async (_, state) => {
      if (!state.container) throw new Error("Missing container");

      // SAFETY: src/index.ts exports WorkspaceOutbound; mint its I/O capability in this DO context.
      const loopback = entrypoints as Cloudflare.Exports & {
        WorkspaceOutbound: LoopbackForExport<typeof WorkspaceOutbound>;
      };

      await state.container.interceptAllOutboundHttp(
        loopback.WorkspaceOutbound({ props: workspace }),
      );
    });

    const version = await sandbox.run(
      "curl --silent --show-error --fail-with-body --max-time 10 http://browser.workspace/json/version",
    );

    expect(version.exitCode, version.stderr).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({
      webSocketDebuggerUrl: "ws://browser.workspace/devtools/browser",
    });
  } finally {
    await sandbox.restart();
  }
});
