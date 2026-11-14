import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import type { WorkspaceOutbound } from "../../src/git-transport";
import { shellQuote, workspaceConfig } from "../../src/workspace";

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
printf '%s' '{"name":"cache-fixture","private":true,"packageManager":"pnpm@12.18.0","dependencies":{"is-number":"7.0.0","get-caller-file":"2.0.5","@cache/helper":"workspace:*"}}' > package.json
printf '%s\\n' 'packages:' '  - packages/*' > pnpm-workspace.yaml
printf '%s' '{"name":"@cache/helper","version":"1.0.0","main":"index.js"}' > packages/helper/package.json
printf '%s' 'module.exports = 42;' > packages/helper/index.js
printf '%s\\n' node_modules/ > .gitignore
git init
git add .
corepack pnpm install --lockfile-only
grep -q 'get-caller-file:' pnpm-lock.yaml
${setup}
node -e 'if(!require("is-number")(42) || typeof require("get-caller-file") !== "function" || require("@cache/helper") !== 42) process.exit(1)'
printf '#!/bin/sh\\nif [ "$2" = "--version" ]; then exec /usr/local/bin/corepack "$@"; fi\\nexit 87\\n' > /workspace/no-install/corepack
chmod +x /workspace/no-install/corepack
cp pnpm-lock.yaml original-lock.yaml
python3 -c 'import shutil; shutil.rmtree("node_modules")'
PATH="/workspace/no-install:$PATH" ${setup}
node -e 'if(!require("is-number")(42) || typeof require("get-caller-file") !== "function" || require("@cache/helper") !== 42) process.exit(1)'`);

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

    const localReferences = await sandbox.run(`set -eu
cd /workspace/repo
PYTHONPATH=/usr/local/lib python3 - <<'PY'
from pathlib import Path
from dependency_cache import cache_key
lock = Path("pnpm-lock.yaml")
original = Path("original-lock.yaml").read_bytes()
try:
    lock.write_bytes(original)
    assert cache_key() is not None, "ordinary package names must remain cacheable"
    for reference in [b"file:../outside", b"portal:../outside", b"helper@file:../outside"]:
        lock.write_bytes(original + b"\\nresolution: '" + reference + b"'\\n")
        assert cache_key() is None, reference
    print("local dependency references remain excluded")
finally:
    lock.write_bytes(original)
PY`);

    expect(localReferences.exitCode, localReferences.stdout + localReferences.stderr).toBe(0);
    expect(localReferences.stdout).toContain("local dependency references remain excluded");

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

const managers: {
  name: string;
  manager?: string;
  bootstrap: string;
  lockfile: string;
  config?: string;
  pnp?: boolean;
}[] = [
  {
    name: "npm inferred from package-lock.json",
    bootstrap: "npm install --package-lock-only",
    lockfile: "package-lock.json",
  },
  {
    name: "npm inferred from npm-shrinkwrap.json",
    bootstrap: "npm install --package-lock-only && npm shrinkwrap",
    lockfile: "npm-shrinkwrap.json",
  },
  {
    name: "npm with a declared version",
    manager: "npm@11.0.0",
    bootstrap: "corepack npm install --package-lock-only",
    lockfile: "package-lock.json",
  },
  {
    name: "Yarn Classic",
    manager: "yarn@1.22.22",
    bootstrap: "corepack yarn install",
    lockfile: "yarn.lock",
  },
  {
    name: "Yarn modern node-modules",
    manager: "yarn@4.18.1",
    bootstrap: "YARN_ENABLE_GLOBAL_CACHE=false corepack yarn install",
    lockfile: "yarn.lock",
    config: "nodeLinker: node-modules\n",
  },
  {
    name: "Yarn modern PnP",
    manager: "yarn@4.18.1",
    bootstrap: "YARN_ENABLE_GLOBAL_CACHE=false corepack yarn install",
    lockfile: "yarn.lock",
    config: "pnpEnableInlining: false\npnpEnableEsmLoader: true\n",
    pnp: true,
  },
  {
    name: "Bun inferred from bun.lock",
    bootstrap: "bun install --lockfile-only",
    lockfile: "bun.lock",
  },
  {
    name: "Bun with a declared version and binary lockfile",
    manager: "bun@1.1.45",
    bootstrap: "npx --yes --package=bun@1.1.45 -- bun install --lockfile-only",
    lockfile: "bun.lockb",
  },
  {
    name: "Bun inferred from a binary lockfile",
    bootstrap: "npx --yes --package=bun@1.1.45 -- bun install --lockfile-only",
    lockfile: "bun.lockb",
  },
  {
    name: "pnpm inferred from pnpm-lock.yaml",
    bootstrap: "corepack pnpm install --lockfile-only",
    lockfile: "pnpm-lock.yaml",
  },
];

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
for executable in ("corepack", "npm", "npx", "bun"):
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
