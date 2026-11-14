import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("tracked source and documentation use the current product name", () => {
  const obsolete = new RegExp(["pi", "hard"].join("[-_\\s]*"), "i");
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
  const matches = [];

  for (const file of files) {
    if (!file || !existsSync(file)) continue;

    const contents = readFileSync(file, "utf8");

    if (obsolete.test(file) || (!contents.includes("\0") && obsolete.test(contents)))
      matches.push(file);
  }

  assert.deepEqual(matches, [], "Obsolete product naming must not return to tracked files");
});
