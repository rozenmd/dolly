import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./run-sandbox-tests.sh", import.meta.url));

for (const exitCode of [0, 7]) {
  test(`rootless container launch preserves the checkout, arguments, and exit status ${exitCode}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-hard-launch-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const checkout = join(directory, "checkout with spaces");
    const runtime = join(directory, "runtime");
    mkdirSync(checkout);
    mkdirSync(join(runtime, "dockerd-rootless"), { recursive: true });
    writeFileSync(join(runtime, "dockerd-rootless", "child_pid"), "12345\n");

    const executable = (name, source) =>
      writeFileSync(join(directory, name), source, { mode: 0o755 });

    executable("uname", "#!/bin/sh\nprintf 'Linux\\n'\n");
    executable("ip", "#!/bin/sh\nexit 0\n");
    executable("docker", "#!/bin/sh\nexit 0\n");
    // Model nsenter's directory reset without requiring Linux namespaces or Docker.
    executable(
      "nsenter",
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
let cwd = "/";
while (args[0]?.startsWith("--")) {
  const flag = args.shift();
  if (flag === "--target") args.shift();
  if (flag.startsWith("--wd=")) cwd = flag.slice(5);
}
const result = spawnSync(args.shift(), args, { cwd, stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
    );
    executable(
      "pnpm",
      `#!${process.execPath}
require("node:fs").writeFileSync(process.env.LAUNCH_RESULT, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
process.exit(${exitCode});
`,
    );
    const output = join(directory, "result.json");

    const result = spawnSync("bash", [script, "test/container/harness.test.ts"], {
      cwd: checkout,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_ACTIONS: "true",
        XDG_RUNTIME_DIR: runtime,
        LAUNCH_RESULT: output,
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, exitCode, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      cwd: checkout,
      args: [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.sandbox.config.ts",
        "test/container/harness.test.ts",
      ],
    });
  });
}
