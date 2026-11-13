import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./.cloudflare/output/v0/workers/default/bundle/index.js",
      config: false,
      miniflare: {
        compatibilityDate: "2026-11-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ACCESS_LOCAL_DEV: process.env.WEB_TEST_ACCESS === "required" ? "false" : "true",
          ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
          ACCESS_AUD: "test-audience",
          CODEX_MODEL: "gpt-6-luna",
        },
        assets: {
          directory: "./.cloudflare/output/v0/workers/default/assets",
          binding: "ASSETS",
          run_worker_first: true,
        },
        artifacts: { WORKSPACES: { namespace: "test-web-workspaces" } },
        durableObjects: {
          AGENT: { className: "Agent", useSQLite: true },
          SANDBOX: { className: "Sandbox", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: [
      process.env.WEB_TEST_ACCESS === "required"
        ? "test/worker/access.test.ts"
        : "test/worker/http.test.ts",
    ],
  },
});
