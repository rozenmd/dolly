import { defineConfig } from "vite-plus";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-11-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ACCESS_LOCAL_DEV: "true",
          CODEX_MODEL: "gpt-6-luna",
        },
        r2Buckets: ["SCREENSHOTS"],
        durableObjects: {
          AGENT: { className: "Agent", useSQLite: true },
          SANDBOX: { className: "Sandbox", useSQLite: true },
        },
      },
      config: false,
    }),
  ],
  test: { include: ["test/*.test.ts"] },
});
