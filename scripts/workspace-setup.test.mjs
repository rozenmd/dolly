import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../container/setup.py", import.meta.url));

for (const [manager, lockfile, expected] of [
  ["pnpm@12.18.0", "pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn@4.0.0", "yarn.lock", ["yarn", "install"]],
  ["npm@11.0.0", "package-lock.json", ["npm", "ci"]],
]) {
  test(`runs repository setup then the declared ${manager} installer`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "dolly-setup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents/setup"), "printf setup > hook-ran\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: manager }));
    writeFileSync(join(root, lockfile), "");
    const output = join(root, "install.json");

    for (const executable of ["corepack", "npm"])
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
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SETUP_RESULT: output },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), expected);
  });
}

test("reports a failed repository hook without running the installer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dolly-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents/setup"), "exit 9\n");
  const result = spawnSync("python3", [script], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exit status 9/);
});
