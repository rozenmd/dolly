import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { sandboxTestConfig } from "./scripts/sandbox-config.ts";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      config: false,
      wrangler: { configPath: await sandboxTestConfig() },
      miniflare: {
        bindings: {
          API_TOKEN: "test-token-with-at-least-32-characters",
          ACCESS_LOCAL_DEV: "true",
          CODEX_MODEL: "gpt-6-luna",
        },
      },
    }),
  ],
  test: { include: ["test/container/*.test.ts"], testTimeout: 300_000 },
}));
