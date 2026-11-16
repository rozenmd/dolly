import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import type { WorkspaceOutbound } from "../../src/git-transport";
import { shellQuote, workspaceConfig } from "../../src/workspace";

type CacheManager = {
  name: string;
  manager?: string;
  bootstrap: string;
  lockfile: string;
  config?: string;
  pnp?: boolean;
};

/** Register unchanged cache journeys in independent files so Vitest can shard them. */
export function cacheManagers(managers: CacheManager[]) {
  for (const manager of managers) {
    it(`restores ${manager.name} without installing and invalidates its lockfile`, async () => {
      const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

      const workspace = workspaceConfig(
        { repository: `fixture/cache-${crypto.randomUUID()}` },
        "cache",
      );

      const token = crypto.randomUUID();
      const setup = `DOLLY_DEPENDENCY_CACHE_TOKEN=${token} python3 /usr/local/lib/dolly-setup.py`;

      const manifest = JSON.stringify({
        name: "cache-fixture",
        private: true,
        packageManager: manager.manager,
        dependencies: { "is-number": "7.0.0" },
      });

      const check = manager.pnp
        ? `test -f .pnp.cjs && test -f .pnp.data.json && test -f .pnp.loader.mjs && node --require ./.pnp.cjs -e 'if(!require("is-number")(42)) process.exit(1)'`
        : `node -e 'if(!require("is-number")(42)) process.exit(1)'`;

      try {
        await sandbox.run("mkdir -p /workspace/repo /workspace/no-install");
        await runInDurableObject(sandbox, async (_, state) => {
          if (!state.container) throw new Error("Missing container");

          // SAFETY: src/index.ts exports WorkspaceOutbound; mint it in the owning DO.
          const loopback = entrypoints as Cloudflare.Exports & {
            WorkspaceOutbound: LoopbackForExport<typeof WorkspaceOutbound>;
          };

          const outbound = loopback.WorkspaceOutbound({
            props: { ...workspace, dependencyCacheToken: token },
          });

          await state.container.interceptAllOutboundHttp(outbound);
          await state.container.interceptOutboundHttps("*", outbound);
        });

        const fixture = await sandbox.run(`set -eu
cd /workspace/repo
printf '%s' ${shellQuote(manifest)} > package.json
${manager.config ? `printf '%s' ${shellQuote(manager.config)} > .yarnrc.yml` : ""}
printf '%s\\n' node_modules/ .yarn/ '.pnp.*' > .gitignore
git init
git add .
${manager.bootstrap}
test -f ${shellQuote(manager.lockfile)}
PYTHONPATH=/usr/local/lib python3 - <<'PY'
from pathlib import Path
import shutil
from dependency_cache import cache_paths
for path in cache_paths(Path.cwd()):
    shutil.rmtree(path) if path.is_dir() else path.unlink()
PY
${setup}
${check}
PYTHONPATH=/usr/local/lib python3 - <<'PY'
from pathlib import Path
import shutil, shlex
from dependency_cache import cache_paths
for path in cache_paths(Path.cwd()):
    shutil.rmtree(path) if path.is_dir() else path.unlink()
for executable in ("npm", "npx", "bun"):
    real = shutil.which(executable)
    if not real:
        continue
    script = Path("/workspace/no-install") / executable
    script.write_text('#!/bin/sh\\nfor last; do :; done\\nif [ "$last" = "--version" ]; then exec ' + shlex.quote(real) + ' "$@"; fi\\nexit 87\\n')
    script.chmod(0o755)
PY
PATH="/workspace/no-install:$PATH" ${setup}
${check}`);

        expect(fixture.exitCode, fixture.stdout + fixture.stderr).toBe(0);
        expect(fixture.stdout).toContain("dependency_cache: miss");
        expect(fixture.stdout).toContain("dependency_cache: stored");
        expect(fixture.stdout).toContain("dependency_cache: restored");

        const invalidated = await sandbox.run(`set -eu
cd /workspace/repo
PYTHONPATH=/usr/local/lib python3 - <<'PY'
from pathlib import Path
import shutil
from dependency_cache import cache_paths
for path in cache_paths(Path.cwd()):
    shutil.rmtree(path) if path.is_dir() else path.unlink()
with Path(${JSON.stringify(manager.lockfile)}).open("ab") as lock:
    lock.write(b"\\n")
PY
PATH="/workspace/no-install:$PATH" ${setup}`);

        expect(invalidated.exitCode).not.toBe(0);
        expect(invalidated.stdout).toContain("dependency_cache: miss");
        expect(invalidated.stderr).toContain("87");
      } finally {
        await sandbox.restart();
      }
    });
  }
}
