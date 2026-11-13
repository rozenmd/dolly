import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../container/checkpoint.py", import.meta.url));

test("checkpoints dirty, staged, ignored, nested-repository and binary files without changing user history or index", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-hard-checkpoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "session");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "tracked"), "original");
  writeFileSync(join(repo, ".gitignore"), "ignored\n");
  git("add", ".");
  git("commit", "-m", "User commit");
  writeFileSync(join(repo, "tracked"), "staged");
  git("add", "tracked");
  writeFileSync(join(repo, "tracked"), "unstaged");
  writeFileSync(join(repo, "ignored"), "keep me");
  writeFileSync(join(repo, "binary\nname"), Buffer.from([0, 255, 1, 0]));
  symlinkSync("tracked", join(repo, "link"));
  mkdirSync(join(repo, "empty"));
  mkdirSync(join(repo, "nested"));
  execFileSync("git", ["init", join(repo, "nested")]);
  const head = git("rev-parse", "HEAD");
  const index = readFileSync(join(repo, ".git", "index"));
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", remote]);

  const checkpoint = (branch, parent = "") => {
    const result = spawnSync("python3", [script, remote, branch, parent, root], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);

    return result.stdout.trim();
  };

  const first = checkpoint("checkpoint-first");
  assert.match(first, /^[a-f0-9]{40}$/);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);

  const read = (path) =>
    execFileSync("git", ["--git-dir=" + remote, "show", "checkpoint-first:" + path]);

  assert.equal(read("files/tracked").toString(), "unstaged");
  assert.equal(read("files/ignored").toString(), "keep me");
  assert.deepEqual(read("files/binary\nname"), Buffer.from([0, 255, 1, 0]));
  assert.equal(read("files/link").toString(), "tracked");
  writeFileSync(join(root, "nested.tar"), read("nested.tar"));
  const nestedFiles = execFileSync("tar", ["-tf", join(root, "nested.tar")], { encoding: "utf8" });
  assert.match(nestedFiles, /files\/nested\/.git\/HEAD/);
  assert.ok(read("directories").includes(Buffer.from("files/empty")));
  writeFileSync(join(root, "git.tar"), read("git.tar"));
  const recovered = join(root, "recovered.git");
  mkdirSync(recovered);
  execFileSync("tar", ["-xf", join(root, "git.tar"), "-C", recovered]);
  assert.equal(
    execFileSync("git", ["--git-dir=" + recovered, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    head,
  );
  assert.equal(
    execFileSync("git", ["--git-dir=" + recovered, "show", ":tracked"], { encoding: "utf8" }),
    "staged",
  );
  rmSync(join(repo, "tracked"));
  checkpoint("checkpoint-second", "refs/heads/checkpoint-first");

  const missing = spawnSync("git", [
    "--git-dir=" + remote,
    "show",
    "checkpoint-second:files/tracked",
  ]);

  assert.notEqual(missing.status, 0);
  assert.equal(
    execFileSync("git", ["--git-dir=" + remote, "rev-parse", "checkpoint-second^"], {
      encoding: "utf8",
    }).trim(),
    first,
  );
});
