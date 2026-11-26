import { writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { convertToWranglerConfig, loadAndParseConfig } from "@cloudflare/config";

/** Vitest 1.7 prepares containers only through its legacy config loader. */
export async function sandboxTestConfig() {
  const { result } = await loadAndParseConfig(
    fileURLToPath(new URL("../cloudflare.config.ts", import.meta.url)),
    { isPreview: false, mode: "test" },
  );

  if (!result.success) throw result.error;

  // Keep the generated file beside the source config so relative build paths retain their meaning.
  const path = fileURLToPath(new URL("../.sandbox-test.wrangler.json", import.meta.url));

  // The sandbox suite never starts Claude Code; the claude-bridge CI suite builds its image.
  const config = convertToWranglerConfig({
    ...result.data,
    containers: result.data.containers?.filter((container) => container.name === "dolly-sandbox"),
  });

  // Exercise the backend directly; the separately built HTTP suite covers the web entrypoint.
  config.main = "./src/index.ts";
  delete config.assets;
  await writeFile(path, JSON.stringify(config, null, 2));

  return path;
}
