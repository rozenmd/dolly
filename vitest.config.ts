import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-11-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          API_TOKEN: "test-token-with-at-least-32-characters",
          ACCESS_LOCAL_DEV: "true",
          GITHUB_WEBHOOK_URL: "https://ingress.example/hooks/github",
          CODEX_MODEL: "gpt-6-luna",
        },
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
