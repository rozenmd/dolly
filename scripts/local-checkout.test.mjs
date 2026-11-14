import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../container/checkout.sh", import.meta.url));

test("shallow local setup fetches fresh refs, supports exact revisions and never resets existing work", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import pathlib, socket, subprocess, sys, tempfile, time
def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, **kwargs).strip()
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    seed = root / "seed"
    run("git", "init", "-b", "main", str(seed))
    def git(*args):
        return run("git", "-C", str(seed), *args)
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.com")
    (seed / "tracked").write_text("first")
    git("add", ".")
    git("commit", "-m", "first")
    first = git("rev-parse", "HEAD")
    git("tag", "v1")
    (seed / "tracked").write_text("latest")
    git("commit", "-am", "latest")
    latest = git("rev-parse", "HEAD")
    run("git", "clone", "--bare", str(seed), str(root / "remote.git"))
    run("git", "--git-dir=" + str(root / "remote.git"), "config", "uploadpack.allowAnySHA1InWant", "true")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    daemon = subprocess.Popen(["git", "daemon", "--export-all", "--reuseaddr", "--listen=127.0.0.1", "--port=" + str(port), "--base-path=" + str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while True:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.1).close()
                break
            except OSError:
                assert time.monotonic() < deadline
                time.sleep(0.01)
        remote = f"git://127.0.0.1:{port}/remote.git"
        for index, (ref, expected) in enumerate([("HEAD", latest), ("main", latest), ("refs/tags/v1", first), (first, first)]):
            workspace = root / str(index)
            workspace.mkdir()
            run("sh", sys.argv[1], remote, ref, "dolly/session-test", str(workspace))
            repo = workspace / "repo"
            assert repo.is_dir() and not repo.is_symlink()
            assert run("git", "-C", str(repo), "rev-parse", "HEAD") == expected
            assert run("git", "-C", str(repo), "rev-list", "--count", "HEAD") == "1"
            assert run("git", "-C", str(repo), "branch", "--show-current") == "dolly/session-test"
            (repo / "tracked").write_text("dirty work")
            before = (repo / ".git/index").read_bytes()
            run("sh", sys.argv[1], "invalid-remote", "invalid-ref", "other-branch", str(workspace))
            assert (repo / "tracked").read_text() == "dirty work"
            assert (repo / ".git/index").read_bytes() == before
        retry = root / "retry"
        retry.mkdir()
        failed = subprocess.run(["sh", sys.argv[1], remote, "missing-ref", "dolly/retry", str(retry)], capture_output=True)
        assert failed.returncode != 0
        assert not (retry / "repo").exists()
        assert not list(retry.glob("setup.*"))
        run("sh", sys.argv[1], remote, "HEAD", "dolly/retry", str(retry))
        unsafe = root / "unsafe"
        (unsafe / "repo").mkdir(parents=True)
        (unsafe / "repo/preserve").write_text("unacknowledged")
        failed = subprocess.run(["sh", sys.argv[1], remote, "HEAD", "dolly/retry", str(unsafe)], capture_output=True)
        assert failed.returncode != 0
        assert (unsafe / "repo/preserve").read_text() == "unacknowledged"
    finally:
        daemon.terminate()
        daemon.wait(timeout=5)
`,
      script,
    ],
    { encoding: "utf8", timeout: 20000 },
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
});
