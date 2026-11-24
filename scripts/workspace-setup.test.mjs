import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../container/setup.py", import.meta.url));

for (const [manager, lockfile, expected] of [
  [
    "pnpm@12.18.0",
    "pnpm-lock.yaml",
    ["--yes", "--package=pnpm@12.18.0", "--", "pnpm", "install", "--frozen-lockfile"],
  ],
  [
    "yarn@4.0.0",
    "yarn.lock",
    ["--yes", "--package=@yarnpkg/cli-dist@4.0.0", "--", "yarn", "install"],
  ],
  ["yarn@1.22.22", "yarn.lock", ["--yes", "--package=yarn@1.22.22", "--", "yarn", "install"]],
  ["npm@11.0.0", "package-lock.json", ["--yes", "--package=npm@11.0.0", "--", "npm", "ci"]],
]) {
  test(`runs repository setup then the declared ${manager} installer`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "dolly-setup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents/setup"), "printf setup > hook-ran\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: manager }));
    writeFileSync(join(root, lockfile), "");
    const output = join(root, "install.json");
    const shims = join(root, "shims");
    mkdirSync(shims);

    for (const executable of ["npx", "npm"])
      writeFileSync(
        join(root, executable),
        `#!${process.execPath}
const fs = require("node:fs");
if (!fs.existsSync("hook-ran")) process.exit(8);
fs.writeFileSync(process.env.SETUP_RESULT, JSON.stringify(process.argv.slice(2)));
`,
        { mode: 0o755 },
      );

    const result = spawnSync("python3", [script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        SETUP_RESULT: output,
        DOLLY_SHIM_DIR: shims,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), expected);

    // Later shells run the same pinned release through the PATH shim.
    const name = manager.split("@")[0];
    const shim = join(shims, name);
    assert.equal(statSync(shim).mode & 0o111, 0o111);

    const shimmed = spawnSync(shim, ["add", "it's"], {
      cwd: root,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SETUP_RESULT: output },
      encoding: "utf8",
    });

    assert.equal(shimmed.status, 0, shimmed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), [
      ...expected.slice(0, 4),
      "add",
      "it's",
    ]);
  });
}

for (const [name, hook, mode, reported] of [
  ["fails", "exit 9\n", 0o644, /- \.agents\/setup exited 9/],
  ["cannot start", "#!/missing/interpreter\n", 0o755, /- \.agents\/setup could not start:/],
]) {
  test(`reports a repository hook that ${name} and still installs dependencies`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "dolly-setup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents/setup"), hook, { mode });
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }));
    writeFileSync(join(root, "npx"), "#!/bin/sh\ntouch installed\n", { mode: 0o755 });
    const shims = join(root, "shims");
    mkdirSync(shims);

    const result = spawnSync("python3", [script], {
      cwd: root,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DOLLY_SHIM_DIR: shims },
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Setup finished with problems:/);
    assert.match(result.stderr, reported);
    assert.ok(statSync(join(root, "installed")).isFile());
  });
}

test("installs from a manifest the repository hook writes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dolly-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents"));
  writeFileSync(
    join(root, ".agents/setup"),
    `printf '%s' '{"packageManager":"npm@11.0.0"}' > package.json\ntouch package-lock.json\n`,
  );
  const output = join(root, "install.json");
  writeFileSync(
    join(root, "npx"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.SETUP_RESULT, JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );
  const shims = join(root, "shims");
  mkdirSync(shims);

  const result = spawnSync("python3", [script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      SETUP_RESULT: output,
      DOLLY_SHIM_DIR: shims,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), [
    "--yes",
    "--package=npm@11.0.0",
    "--",
    "npm",
    "ci",
  ]);
});

test("pins an undeclared pnpm shim to the release npx resolves", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dolly-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "pnpm-lock.yaml"), "");
  writeFileSync(
    join(root, "npx"),
    `#!/bin/sh\nfor last; do :; done\n[ "$last" = --version ] && echo 10.2.3\nexit 0\n`,
    { mode: 0o755 },
  );
  const shims = join(root, "shims");
  mkdirSync(shims);

  const result = spawnSync("python3", [script], {
    cwd: root,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, DOLLY_SHIM_DIR: shims },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(shims, "pnpm"), "utf8"), /--package=pnpm@10\.2\.3 -- pnpm "\$@"/);
});

test("keeps installing when the shim directory is not writable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dolly-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.2.3" }));
  writeFileSync(join(root, "npx"), "#!/bin/sh\ntouch installed\n", { mode: 0o755 });

  const result = spawnSync("python3", [script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      DOLLY_SHIM_DIR: join(root, "missing"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /could not add pnpm to PATH/);
  assert.ok(statSync(join(root, "installed")).isFile());
});
