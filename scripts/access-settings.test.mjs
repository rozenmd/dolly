import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { exportAccessSettings, readAccessSettings } from "./access-settings.ts";

const directories = [];

const settings = {
  ACCESS_AUD: "a".repeat(64),
  ACCESS_TEAM_DOMAIN: "pi-hard.cloudflareaccess.com",
  hostname: "pi-hard.example.workers.dev",
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-hard-access-"));
  directories.push(directory);

  return {
    output: pathToFileURL(join(directory, "output.json")),
    target: pathToFileURL(join(directory, "access.generated.json")),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

test("missing settings keep an unconfigured deployment fail-closed", () => {
  assert.deepEqual(readAccessSettings(fixture().target), {
    ACCESS_AUD: "",
    ACCESS_TEAM_DOMAIN: "",
  });
});

test("exports resolved Alchemy output for the Worker without unrelated fields", () => {
  const { output, target } = fixture();
  writeFileSync(output, JSON.stringify({ ...settings, clientSecret: "never-export-me" }));
  assert.deepEqual(exportAccessSettings(output, target), settings);
  assert.deepEqual(readAccessSettings(target), settings);
  assert.equal(readFileSync(target, "utf8").includes("never-export-me"), false);
});

test("missing or invalid stack output never replaces existing settings", () => {
  const { output, target } = fixture();
  writeFileSync(target, JSON.stringify(settings));
  assert.throws(() => exportAccessSettings(output, target));

  for (const invalid of [
    "not JSON",
    JSON.stringify({ ...settings, ACCESS_AUD: "" }),
    JSON.stringify({ ...settings, ACCESS_TEAM_DOMAIN: "https://pi-hard.cloudflareaccess.com" }),
    JSON.stringify({ ...settings, hostname: "*.workers.dev" }),
    JSON.stringify({ ACCESS_AUD: { expression: "unresolved" } }),
  ]) {
    writeFileSync(output, invalid);
    assert.throws(() => exportAccessSettings(output, target));
    assert.deepEqual(readAccessSettings(target), settings);
  }
});

test("malformed generated configuration fails rather than silently disabling Access", () => {
  const { target } = fixture();
  writeFileSync(target, "{}");
  assert.throws(() => readAccessSettings(target));
});
