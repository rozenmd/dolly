import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../test/fixtures/legacy-checkpoint.py", import.meta.url));
const restore = fileURLToPath(new URL("../container/restore-legacy.py", import.meta.url));

const modernPython =
  spawnSync("python3", ["-c", "import tarfile; assert hasattr(tarfile, 'data_filter')"]).status ===
  0;

for (const symlinked of [false, true])
  test(`checkpoints dirty, staged, ignored, nested-repository and binary files without changing user history or index (symlinked root=${symlinked})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "dolly-checkpoint-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "repo");

    if (symlinked) {
      const mounted = join(root, "mounted");
      mkdirSync(mounted);
      symlinkSync(mounted, repo);
    } else mkdirSync(repo);

    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

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

    const nestedFiles = execFileSync("tar", ["-tf", join(root, "nested.tar")], {
      encoding: "utf8",
    });

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
    await t.test(
      "imports the acknowledged legacy checkpoint without FUSE",
      { skip: !modernPython },
      () => {
        const workspace = join(root, "local-workspace");
        mkdirSync(workspace);

        const wrong = spawnSync(
          "python3",
          [restore, remote, "checkpoint-first", "0".repeat(40), workspace],
          { encoding: "utf8" },
        );

        assert.notEqual(wrong.status, 0);

        const imported = spawnSync(
          "python3",
          [restore, remote, "checkpoint-first", first, workspace],
          {
            encoding: "utf8",
          },
        );

        assert.equal(imported.status, 0, imported.stdout + imported.stderr);
        const local = join(workspace, "repo");

        const restoredGit = (...args) =>
          execFileSync("git", ["-C", local, ...args], { encoding: "utf8" });

        assert.equal(restoredGit("rev-parse", "HEAD").trim(), head);
        assert.equal(restoredGit("show", ":tracked"), "staged");
        assert.equal(readFileSync(join(local, "tracked"), "utf8"), "unstaged");
        assert.equal(readFileSync(join(local, "ignored"), "utf8"), "keep me");
        assert.equal(readFileSync(join(local, "link"), "utf8"), "unstaged");
        assert.deepEqual(readFileSync(join(local, ".git/index")), index);
        assert.deepEqual(readFileSync(join(local, "binary\nname")), Buffer.from([0, 255, 1, 0]));
        assert.equal(
          execFileSync("git", ["-C", join(local, "nested"), "rev-parse", "--is-inside-work-tree"], {
            encoding: "utf8",
          }).trim(),
          "true",
        );
        assert.equal(execFileSync("test", ["-d", join(local, "empty")], { encoding: "utf8" }), "");
        readFileSync(join(workspace, "ready"));
      },
    );
  });
