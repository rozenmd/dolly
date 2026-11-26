import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./ci-plan.mjs", import.meta.url));
const runner = fileURLToPath(new URL("./ci-run.mjs", import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "dolly-ci-plan-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci@example.com");
  git("commit", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");

  const change = (path) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-m", path);
  };

  const plan = (event = "pull_request_target", ref = base) =>
    JSON.parse(
      execFileSync(process.execPath, [script], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: event,
          CI_BASE: ref,
          GITHUB_OUTPUT: "",
          GITHUB_STEP_SUMMARY: "",
        },
      }),
    );

  return { cwd, git, base, change, plan };
}

test("CI planner uses a real merge base and selects frontend import-graph tests", (t) => {
  const { git, base, change, plan } = fixture(t);
  git("switch", "-c", "pr");
  change("web/src/lib/api.ts");
  git("switch", "main");
  change("src/new-on-main.ts");
  const newerBase = git("rev-parse", "HEAD");
  git("switch", "pr");
  const result = plan("pull_request_target", newerBase);
  assert.equal(result.base, base);
  assert.equal(result.full, false);
  assert.equal(result.matrix.include.find((job) => job.suite === "web").mode, "changed");
  assert.ok(result.matrix.include.some((job) => job.suite === "worker"));
  assert.ok(result.matrix.include.some((job) => job.suite === "build"));
  assert.ok(!result.matrix.include.some((job) => job.suite === "sandbox"));
});

test("CI planner does not use imports to select dynamic Worker/DO entrypoints", (t) => {
  const { change, plan } = fixture(t);
  change("src/agent.ts");
  const jobs = plan().matrix.include;

  for (const suite of ["root", "sandbox", "worker", "build"])
    assert.ok(
      jobs.some((job) => job.suite === suite && job.mode === "full"),
      suite,
    );
  assert.equal(jobs.filter((job) => job.suite === "root").length, 2);
  assert.equal(jobs.filter((job) => job.suite === "sandbox").length, 2);
});

test("CI planner runs everything for configs, non-imported and generated inputs", (t) => {
  const { change, plan } = fixture(t);

  for (const path of [
    "pnpm-lock.yaml",
    "web/vitest.config.ts",
    "web/src/routeTree.gen.ts",
    "test/session.ts",
    "web/src/styles.css",
    "Dockerfile",
    "claude-bridge/src/bridge.ts",
    "unclassified-input",
  ]) {
    change(path);
    const result = plan();
    assert.equal(result.full, true, path);
    assert.ok(result.matrix.include.some((job) => job.suite === "claude-bridge"));
    assert.equal(result.matrix.include.length, 14);
    assert.ok(result.matrix.include.every((job) => job.mode === "full"));
  }
});

test("CI planner fails safe for missing history, main and merge queue", (t) => {
  const { change, plan } = fixture(t);
  change("web/src/lib/api.ts");

  for (const [event, base] of [
    ["push", "missing"],
    ["merge_group", "missing"],
    ["pull_request_target", "missing"],
  ]) {
    const result = plan(event, base);
    assert.equal(result.full, true);
    assert.equal(result.matrix.include.length, 14);
  }
});

test("CI planner includes both sides of renames and deleted non-imported inputs", (t) => {
  const { cwd, git, change, plan } = fixture(t);
  change("config.json");
  const base = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, "web/src/lib"), { recursive: true });
  git("mv", "config.json", "web/src/lib/api.ts");
  git("commit", "-m", "rename");
  assert.equal(plan("pull_request_target", base).full, true);
  git("rm", "web/src/lib/api.ts");
  git("commit", "-m", "delete");
  assert.equal(plan("pull_request_target", base).full, true);
});

test("CI runner executes only Vitest tests reachable from a real committed diff", (t) => {
  const { cwd, git, change } = fixture(t);
  symlinkSync(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(cwd, "node_modules"),
    "dir",
  );
  mkdirSync(join(cwd, "web/src"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\nci-results*.json\n");
  writeFileSync(join(cwd, "package.json"), '{"type":"module","packageManager":"pnpm@12.18.0"}\n');
  writeFileSync(join(cwd, "web/package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(cwd, "web/vitest.config.ts"),
    'import { defineConfig } from "vite-plus"; export default defineConfig({test: {include: ["src/*.test.ts"]}});\n',
  );

  for (const name of ["a", "b"]) {
    writeFileSync(join(cwd, `web/src/${name}.ts`), "export const value = 0;\n");
    writeFileSync(
      join(cwd, `web/src/${name}.test.ts`),
      `import { test, expect } from "vite-plus/test"; import { value } from "./${name}"; test("${name}", () => expect(value).toBeGreaterThanOrEqual(0));\n`,
    );
  }

  git("add", ".");
  git("commit", "-m", "test graph");
  const base = git("rev-parse", "HEAD");
  change("web/src/a.ts");

  const result = spawnSync(process.execPath, [runner, "web"], {
    cwd,
    env: { ...process.env, CI_MODE: "changed", CI_BASE: base, CI_SHARD: "1/1" },
    stdio: "pipe",
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(cwd, "web/ci-results-web-1-1.json"), "utf8"));
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.testResults.length, 1);
  assert.ok(report.testResults[0].name.endsWith("/src/a.test.ts"));

  const full = spawnSync(process.execPath, [runner, "web"], {
    cwd,
    env: { ...process.env, CI_MODE: "full", CI_SHARD: "1/1" },
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(cwd, "web/ci-results-web-1-1.json"), "utf8")).numPassedTests,
    2,
  );

  rmSync(join(cwd, "web/src/a.test.ts"));
  rmSync(join(cwd, "web/src/b.test.ts"));

  const empty = spawnSync(process.execPath, [runner, "web"], {
    cwd,
    env: { ...process.env, CI_MODE: "full", CI_SHARD: "1/1" },
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(empty.status, 1, "A full run must not pass with no tests");
});
