import { readFileSync } from "node:fs";

// Feed this the downloaded ci-results.json artifacts. Never let timings choose coverage:
// the sequencer uses them only to distribute every selected file exactly once.
const timings = new Map();

for (const path of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(path, "utf8"));

  for (const result of report.testResults) {
    const file = result.name.replaceAll("\\", "/").match(/(?:^|\/)(test\/.*\.test\.ts)$/)?.[1];

    if (file && result.status === "passed")
      timings.set(file, Math.max(1, Math.round(result.endTime - result.startTime)));
  }
}

if (!timings.size) throw new Error("No passing test-file timings found in the supplied reports");

console.log(
  JSON.stringify(Object.fromEntries([...timings].sort(([a], [b]) => a.localeCompare(b))), null, 2),
);
