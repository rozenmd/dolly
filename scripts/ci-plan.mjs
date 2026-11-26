import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const base = process.env.CI_BASE;
let mergeBase = "";
let changes = [];
let full = process.env.GITHUB_EVENT_NAME !== "pull_request_target";

if (!full) {
  try {
    mergeBase = git("merge-base", base, "HEAD").trim();
    // Include both sides of renames, and deleted inputs. Never infer from HEAD alone.
    changes = git("diff", "--name-only", "--no-renames", "-z", mergeBase, "HEAD")
      .split("\0")
      .filter(Boolean);
    // Only these source/test inputs have an understood dependency boundary.
    // Configs, lockfiles, generated clients, scripts, assets and unknown paths run everything.
    full = changes.some(
      (path) =>
        !/^(src\/.*\.ts|web\/src\/.*\.(ts|tsx)|test\/(?:container\/|worker\/)?[^/]+\.test\.ts|web\/e2e\/.*\.ts)$/.test(
          path,
        ) || /(?:^|\/)[^/]*(?:\.gen|\.generated)\./.test(path),
    );
  } catch {
    full = true;
  }
}

const touches = (prefix) => changes.some((path) => path.startsWith(prefix));
const backend = touches("src/");

const include = ["format", "lint", "types-root", "types-infra", "types-web", "node"].map(
  (suite) => ({
    suite,
    shard: "1/1",
    mode: "full",
  }),
);

function add(suite, count, needed, mode = "full") {
  if (!full && !needed) return;

  for (let shard = 1; shard <= count; shard++)
    include.push({ suite, shard: `${shard}/${count}`, mode: full ? "full" : mode });
}

// Worker/DO entrypoints and built browser bundles are not ordinary test imports.
// Backend source changes therefore run ALL backend/container and bundled tests.
add("root", 2, backend || touches("test/"), backend ? "full" : "changed");

add("web", 1, backend || touches("web/src/"), "changed");

add("worker", 1, backend || touches("web/") || touches("test/worker/"));

add("sandbox", 2, backend || touches("test/container/"));

add("build", 1, backend || touches("web/src/"));

// The Claude Code bridge is its own npm package, run in its own container.
add("claude-bridge", 1, touches("claude-bridge/"));

const plan = { matrix: { include }, base: mergeBase, full };

console.log(JSON.stringify(plan));

if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify(plan.matrix)}\nbase=${mergeBase}\n`,
  );

if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### CI selection\n\nMode: ${full ? "full" : "affected"}\n\nMerge base: \`${mergeBase || "not needed/unavailable"}\`\n\n` +
      include.map((job) => `- ${job.suite} ${job.shard}: ${job.mode}`).join("\n") +
      "\n",
  );
