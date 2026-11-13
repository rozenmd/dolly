import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../container/exec.py", import.meta.url));
const linux = { skip: process.platform !== "linux" };

test("command supervisor preserves output and exit status", linux, () => {
  for (const code of [0, 7]) {
    const result = spawnSync(
      "python3",
      [script, `printf stdout; printf stderr >&2; exit ${code}`],
      {
        encoding: "utf8",
      },
    );

    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stdout, "stdout");
    assert.equal(result.stderr, "stderr");
  }
});

for (const signum of [2, 15])
  test(
    `command supervisor cancels and escalates the entire group on signal ${signum}`,
    linux,
    () => {
      // Python drives the fixture so this also exercises real process groups on Linux.
      const result = spawnSync(
        "python3",
        [
          "-c",
          `
import os, pathlib, signal, subprocess, sys, tempfile, time
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    fixture = root / "fixture.py"
    fixture.write_text("""
import os, pathlib, signal, sys, time
root = pathlib.Path(sys.argv[1])
def terminate(_signal, _frame):
    (root / 'index.lock').unlink()
    sys.exit(0)
signal.signal(signal.SIGTERM, terminate)
(root / 'index.lock').touch()
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (root / 'child').write_text(str(os.getpid()))
else:
    (root / 'parent').write_text(str(os.getpid()))
while True:
    time.sleep(0.1)
""")
    import shlex
    command = shlex.join(["python3", str(fixture), str(root)])
    process = subprocess.Popen([sys.executable, sys.argv[1], command])
    group = None
    try:
        deadline = time.monotonic() + 5
        while not (root / "child").exists() or not (root / "parent").exists():
            assert time.monotonic() < deadline, "command did not start"
            time.sleep(0.01)
        pids = [int((root / name).read_text()) for name in ["parent", "child"]]
        group = os.getpgid(pids[0])
        process.send_signal(int(sys.argv[2]))
        assert process.wait(timeout=5) == 128 + int(sys.argv[2])
        assert not (root / "index.lock").exists(), "Git-style TERM cleanup did not run"
        for pid in pids:
            state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
            assert not state or state.startswith("Z"), f"child {pid} survived: {state}"
        group = None
    finally:
        if group is not None:
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if process.poll() is None:
            process.kill()
            process.wait()
`,
          script,
          String(signum),
        ],
        { encoding: "utf8", timeout: 15000 },
      );

      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
  );
