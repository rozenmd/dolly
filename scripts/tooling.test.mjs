import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function fixture(t, source) {
  const directory = mkdtempSync(join(tmpdir(), "dolly-tooling-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.ts");
  writeFileSync(path, source);

  return path;
}

function run(tool, args) {
  return spawnSync(process.execPath, [join(root, "node_modules/vite-plus/bin/vp"), tool, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("Oxlint loads the vendored generic rules and rejects chained assertions", (t) => {
  const path = fixture(t, "export const token = 1 as unknown as string;\n");
  const result = run("lint", [path]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /anti-slop\(no-chained-type-assertions\)/);
});

test("Oxlint loads the vendored Effect rules and rejects manual tagged construction", (t) => {
  const path = fixture(t, 'export const event = { _tag: "Ready" };\n');
  const result = run("lint", [path]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /anti-slop-effect\(no-manual-tagged-construction\)/);
});

test("Vite+ preserves the ban on module mocking through its Vitest exports", (t) => {
  const path = fixture(t, 'import { vi } from "vite-plus/test";\nvi.mock("./dependency");\n');
  const result = run("lint", [path]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /anti-slop\(no-module-mocking\)/);
});

test("oxfmt rejects unformatted source and accepts its formatted output", (t) => {
  const path = fixture(t, "export const number=1;\n");
  const check = () => run("fmt", ["--check", path]);
  const before = check();
  assert.equal(before.status, 1, before.stdout + before.stderr);
  const formatted = run("fmt", ["--write", path]);
  assert.equal(formatted.status, 0, formatted.stdout + formatted.stderr);
  const after = check();
  assert.equal(after.status, 0, after.stdout + after.stderr);
});
