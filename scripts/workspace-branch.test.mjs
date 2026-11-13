import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../container/branch.sh", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dolly-branch-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  writeFileSync(join(root, "tracked"), "initial");
  git("add", ".");
  git("commit", "-m", "initial");

  const branch = () =>
    spawnSync("sh", [script, "dolly/session-test"], { cwd: root, encoding: "utf8" });

  return { root, git, branch };
}

test("session branch creation preserves index, dirty/staged files and retry history", (t) => {
  const { root, git, branch } = fixture(t);
  writeFileSync(join(root, "tracked"), "staged");
  git("add", "tracked");
  writeFileSync(join(root, "tracked"), "unstaged");
  const index = readFileSync(join(root, ".git/index"));
  // No index refresh or lock removal: the operation must only touch refs/HEAD.
  writeFileSync(join(root, ".git/index.lock"), "do not remove");
  const result = branch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("symbolic-ref", "HEAD"), "refs/heads/dolly/session-test");
  assert.deepEqual(readFileSync(join(root, ".git/index")), index);
  assert.equal(readFileSync(join(root, "tracked"), "utf8"), "unstaged");
  assert.equal(readFileSync(join(root, ".git/index.lock"), "utf8"), "do not remove");
  unlinkSync(join(root, ".git/index.lock"));
  git("commit", "-m", "session work");
  const advanced = git("rev-parse", "HEAD");
  assert.equal(branch().status, 0);
  assert.equal(git("rev-parse", "HEAD"), advanced);
  assert.deepEqual(readFileSync(join(root, "tracked"), "utf8"), "unstaged");
  // Switching back must not let a retried setup overwrite a different branch tip.
  git("symbolic-ref", "HEAD", "refs/heads/main");
  assert.notEqual(branch().status, 0);
  assert.equal(git("rev-parse", "refs/heads/dolly/session-test"), advanced);
});

test("session branch creation needs neither file contents nor a worktree refresh", (t) => {
  const { root, git, branch } = fixture(t);
  const blob = git("rev-parse", "HEAD:tracked");
  unlinkSync(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  unlinkSync(join(root, "tracked"));
  const index = readFileSync(join(root, ".git/index"));
  const head = git("rev-parse", "HEAD");
  const result = branch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.deepEqual(readFileSync(join(root, ".git/index")), index);
});
