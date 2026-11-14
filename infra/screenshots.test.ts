import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { screenshotsBucket, screenshotsExpiry } from "./screenshots.ts";

test("provisions a private WEUR screenshot bucket with the matching Worker binding", () => {
  assert.deepEqual(screenshotsBucket, {
    name: "dolly-screenshots",
    locationHint: "weur",
    publicAccess: false,
  });
  const stack = readFileSync(new URL("./alchemy.run.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");

  assert.match(
    stack,
    /Cloudflare\.R2\.Bucket\("Screenshots", \{\s*\.\.\.screenshotsBucket,\s*lifecycleRules: \[screenshotsExpiry\],?\s*\}\)\.pipe\(retain\(\)\)/,
  );
  assert.match(worker, /SCREENSHOTS: bindings\.r2\(\{ name: screenshotsBucket\.name \}\)/);
});

test("expires all uploaded assets after 30 days", () => {
  assert.deepEqual(screenshotsExpiry, {
    id: "expire-assets-after-30-days",
    enabled: true,
    prefix: "",
    deleteObjectsTransition: {
      condition: { type: "Age", maxAge: 2_592_000 },
    },
  });
});
