import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { URL } from "node:url";
import * as Schema from "effect/Schema";

export const AccessSettings = Schema.Struct({
  PR_SCREENSHOTS_URL: Schema.optional(
    Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9-]+\.r2\.dev$/)),
  ),
  ACCESS_AUD: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ACCESS_TEAM_DOMAIN: Schema.String.check(
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/),
  ),
  hostname: Schema.String.check(
    Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  ),
});

export const accessSettingsPath = new URL("../infra/access.generated.json", import.meta.url);

export function readAccessSettings(path = accessSettingsPath) {
  if (!existsSync(path)) return { ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "", PR_SCREENSHOTS_URL: "" };

  return Schema.decodeUnknownSync(AccessSettings)(JSON.parse(readFileSync(path, "utf8")));
}

export function exportAccessSettings(outputPath: URL, targetPath = accessSettingsPath) {
  const settings = Schema.decodeUnknownSync(AccessSettings)(
    JSON.parse(readFileSync(outputPath, "utf8")),
  );

  const temporaryPath = new URL(`${targetPath}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, targetPath);

  return settings;
}
