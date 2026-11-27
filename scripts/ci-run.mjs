import { spawnSync } from "node:child_process";

const suite = process.argv[2];

const changed =
  process.env.CI_MODE === "changed" ? ["--changed", process.env.CI_BASE, "--passWithNoTests"] : [];

if (changed.length && !/^[a-f0-9]{40}$/.test(process.env.CI_BASE ?? ""))
  throw new Error("Affected test runs require a resolved merge-base SHA");

const report = [
  "--reporter=default",
  "--reporter=json",
  `--outputFile=ci-results-${suite}-${(process.env.CI_SHARD ?? "1/1").replace("/", "-")}.json`,
];

const shard = ["--shard", process.env.CI_SHARD ?? "1/1"];

const commands = {
  format: [["run", "format:check"]],
  lint: [["run", "lint"]],
  "types-root": [["exec", "tsrs", "--noEmit"]],
  "types-infra": [["--dir", "infra", "typecheck"]],
  "types-web": [["--dir", "web", "typecheck"]],
  // The same script `pnpm verify` and `pnpm test` run, so local checks cover this job.
  node: [["run", "test:node"]],
  root: [["exec", "vp", "test", "run", ...changed, ...shard, ...report]],
  web: [
    [
      "--dir",
      "web",
      "exec",
      "vp",
      "test",
      "run",
      "--config",
      "vitest.config.ts",
      ...changed,
      ...report,
    ],
  ],
  worker: [["run", "test:worker"]],
  sandbox: [["run", "test:sandbox", ...shard, ...report]],
  build: [["run", "build"]],
  "claude-bridge": [
    ["exec", "npm", "ci", "--prefix", "claude-bridge"],
    ["run", "test:claude-bridge"],
    ["exec", "docker", "build", "--file", "claude-bridge/Dockerfile", "claude-bridge"],
  ],
};

if (!Object.hasOwn(commands, suite)) throw new Error(`Unknown CI suite: ${suite}`);

for (const args of commands[suite]) {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);
}
