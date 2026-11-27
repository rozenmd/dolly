import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../container/exec.py", import.meta.url));
const linux = { skip: process.platform !== "linux" };

// The Worker's fixed script: the command travels in DOLLY_COMMAND, not argv.
const { EXEC_SCRIPT: evalScript } = await import("../src/exec-script.ts");

const home = mkdtempSync(join(tmpdir(), "dolly-exec-home-"));

const run = (command, options = {}) =>
  spawnSync("python3", [script, evalScript], {
    encoding: "utf8",
    timeout: 15000,
    ...options,
    // A hermetic HOME: the host's login files (such as ~/.bash_logout) are not under test.
    env: { ...process.env, HOME: home, DOLLY_COMMAND: command },
  });

test("command supervisor preserves output and exit status", linux, () => {
  for (const code of [0, 7]) {
    const result = run(`printf stdout; printf stderr >&2; exit ${code}`);

    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stdout, "stdout");
    assert.equal(result.stderr, "stderr");
  }
});

test("command supervisor runs commands with bash", linux, () => {
  const result = run(
    [
      "a=(x y z); echo ${#a[@]} ${a[1]}",
      "x=banana; echo ${x//a/o}",
      "false | true; echo ${PIPESTATUS[0]}",
      "echo pre{a,b}post",
      "[[ abc == a* ]] && echo glob",
    ].join("\n"),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "3 y\nbonono\n1\npreapost prebpost\nglob\n");
});

test("older sh supervisors still run commands with bash", linux, () => {
  // Workspaces restored from an older snapshot keep a supervisor that runs `sh -lc`.
  const marker = `dolly-marker-${randomUUID()}`;

  const result = spawnSync("sh", ["-lc", evalScript], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      HOME: home,
      DOLLY_COMMAND: `a=(x y z); echo \${a[1]} \${PIPESTATUS[0]} pre{a,b}
pgrep -f "${marker}" && exit 9
test -z "\${DOLLY_COMMAND+set}" || exit 7
exit 4`,
    },
  });

  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.stdout, "y 0 prea preb\n");
  assert.equal(result.stderr, "");
});

test("command text stays out of every process's argv", linux, () => {
  // pgrep never matches itself, so any match is the supervisor or its shell.
  const marker = `dolly-marker-${randomUUID()}`;

  const result = run(
    `pgrep -af "${marker}" && exit 9
for p in $(pgrep -f "${marker}"); do kill $p; done
# [d] keeps grep's own argv from matching.
grep -l "[d]${marker.slice(1)}" /proc/[0-9]*/cmdline 2>/dev/null && exit 8
test -z "\${DOLLY_COMMAND+set}" || exit 7
echo survived`,
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "survived\n");
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
    (root / 'child.tmp').write_text(str(os.getpid()))
    (root / 'child.tmp').replace(root / 'child')
else:
    (root / 'parent.tmp').write_text(str(os.getpid()))
    (root / 'parent.tmp').replace(root / 'parent')
while True:
    time.sleep(0.1)
""")
    import shlex
    command = shlex.join(["python3", str(fixture), str(root)])
    process = subprocess.Popen([sys.executable, sys.argv[1], sys.argv[3]], env={**os.environ, "DOLLY_COMMAND": command})
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
          evalScript,
        ],
        { encoding: "utf8", timeout: 15000 },
      );

      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
  );
