import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import type { WorkspaceOutbound } from "../../src/git-transport";
import { workspaceConfig } from "../../src/workspace";

it("installs once, restores zstd node_modules through the broker, and invalidates changed inputs", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  const workspace = workspaceConfig(
    { repository: `fixture/cache-${crypto.randomUUID()}` },
    "cache",
  );

  const token = crypto.randomUUID();

  const setup = `DOLLY_DEPENDENCY_CACHE_TOKEN=${token} python3 /usr/local/lib/dolly-setup.py`;

  try {
    await sandbox.run("mkdir -p /workspace/repo/packages/helper /workspace/no-install");
    await runInDurableObject(sandbox, async (_, state) => {
      if (!state.container) throw new Error("Missing container");

      // SAFETY: src/index.ts exports WorkspaceOutbound; mint its I/O capability in this DO context.
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
printf '%s' '{"name":"cache-fixture","private":true,"packageManager":"pnpm@12.18.0","dependencies":{"is-number":"7.0.0","@cache/helper":"workspace:*"}}' > package.json
printf '%s\\n' 'packages:' '  - packages/*' > pnpm-workspace.yaml
printf '%s' '{"name":"@cache/helper","version":"1.0.0","main":"index.js"}' > packages/helper/package.json
printf '%s' 'module.exports = 42;' > packages/helper/index.js
printf '%s\\n' node_modules/ > .gitignore
git init
git add .
corepack pnpm install --lockfile-only
${setup}
node -e 'if(!require("is-number")(42) || require("@cache/helper") !== 42) process.exit(1)'
printf '#!/bin/sh\\nexit 87\\n' > /workspace/no-install/corepack
chmod +x /workspace/no-install/corepack
cp pnpm-lock.yaml original-lock.yaml
python3 -c 'import shutil; shutil.rmtree("node_modules")'
PATH="/workspace/no-install:$PATH" ${setup}
node -e 'if(!require("is-number")(42) || require("@cache/helper") !== 42) process.exit(1)'`);

    expect(fixture.exitCode, fixture.stdout + fixture.stderr).toBe(0);
    expect(fixture.stdout).toContain("dependency_cache: miss");
    expect(fixture.stdout).toContain("dependency_cache: stored");
    expect(fixture.stdout).toContain("dependency_cache: restored");

    const invalidated = await sandbox.run(`set -eu
cd /workspace/repo
python3 -c 'import shutil; shutil.rmtree("node_modules")'
printf '\\n# changed dependency input\\n' >> pnpm-lock.yaml
PATH="/workspace/no-install:$PATH" ${setup}`);

    expect(invalidated.exitCode).not.toBe(0);
    expect(invalidated.stdout).toContain("dependency_cache: miss");
    expect(invalidated.stderr).toContain("87");

    const unavailable = await sandbox.run(`set -eu
cd /workspace/repo
cp original-lock.yaml pnpm-lock.yaml
DOLLY_DEPENDENCY_CACHE_TOKEN=wrong python3 /usr/local/lib/dolly-setup.py
node -e 'if(!require("is-number")(42)) process.exit(1)'`);

    expect(unavailable.exitCode, unavailable.stderr).toBe(0);
    expect(unavailable.stdout).toContain("dependency_cache: miss");
    expect(unavailable.stdout).not.toContain("dependency_cache: restored");

    const unsafe = await sandbox.run(`set -eu
cd /workspace/repo
DOLLY_DEPENDENCY_CACHE_TOKEN=${token} PYTHONPATH=/usr/local/lib python3 - <<'PY'
import hashlib, io, shutil, subprocess, tarfile, tempfile
from pathlib import Path
import dependency_cache as cache
shutil.rmtree("node_modules")
before = Path("package.json").read_bytes()
with tempfile.TemporaryDirectory() as scratch:
    archive = Path(scratch) / "unsafe.tar.zst"
    for index, name in enumerate(["../escape", "package.json", "node_modules/../../escape", "node_modules/escape", "corrupt"]):
        key = hashlib.sha256(name.encode()).hexdigest()
        if name == "corrupt":
            archive.write_bytes(b"not zstd")
        else:
            content = io.BytesIO()
            with tarfile.open(fileobj=content, mode="w") as tar:
                member = tarfile.TarInfo(name)
                if name == "node_modules/escape":
                    member.type = tarfile.SYMTYPE
                    member.linkname = "../../escape"
                    tar.addfile(member)
                else:
                    member.size = 6
                    tar.addfile(member, io.BytesIO(b"unsafe"))
            subprocess.run(["zstd", "-q", "-f", "-o", str(archive)], input=content.getvalue(), check=True)
        assert cache.transfer("PUT", key, archive) == 201
        assert not cache.restore(key), name
        assert not Path("node_modules").exists()
assert Path("package.json").read_bytes() == before
assert not Path("/workspace/escape").exists()
print("unsafe archives rejected")
PY`);

    expect(unsafe.exitCode, unsafe.stdout + unsafe.stderr).toBe(0);
    expect(unsafe.stdout).toContain("unsafe archives rejected");

    await runInDurableObject(sandbox, async (_, state) => {
      if (!state.container) throw new Error("Missing container");

      // SAFETY: the loopback export is declared by src/index.ts, as above.
      const loopback = entrypoints as Cloudflare.Exports & {
        WorkspaceOutbound: LoopbackForExport<typeof WorkspaceOutbound>;
      };

      await state.container.interceptAllOutboundHttp(
        loopback.WorkspaceOutbound({ props: workspace }),
      );
    });

    const revoked = await sandbox.run(
      `curl -s -o /dev/null -w '%{http_code}' -H 'X-Dolly-Dependency-Cache: ${token}' http://dependencies.workspace/v1/${"a".repeat(64)}`,
    );

    expect(revoked.stdout).toBe("403");
  } finally {
    await sandbox.restart();
  }
});
