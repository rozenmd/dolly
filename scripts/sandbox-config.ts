import { writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { convertToWranglerConfig, loadAndParseConfig } from "@cloudflare/config";

/** Vitest 1.7 prepares native containers only through its legacy config loader. */
export async function sandboxTestConfig() {
  const { result } = await loadAndParseConfig(
    fileURLToPath(new URL("../cloudflare.config.ts", import.meta.url)),
    { isPreview: false, mode: "test" },
  );

  if (!result.success) throw result.error;

  // Keep the generated file beside the source config so relative build paths retain their meaning.
  const path = fileURLToPath(new URL("../.sandbox-test.wrangler.json", import.meta.url));
  await writeFile(path, JSON.stringify(convertToWranglerConfig(result.data), null, 2));

  return path;
}
