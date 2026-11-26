import { defineConfig } from "vite-plus";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

const workerOutput = "./.cloudflare/output/v1/workers/default";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: `${workerOutput}/bundle/index.js`,
      config: false,
      miniflare: {
        compatibilityDate: "2026-11-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ACCESS_LOCAL_DEV: process.env.WEB_TEST_ACCESS === "required" ? "false" : "true",
          ACCESS_TEAM_DOMAIN: "example-team.cloudflareaccess.com",
          ACCESS_AUD: "test-audience",
        },
        assets: {
          directory: `${workerOutput}/assets`,
          binding: "ASSETS",
          run_worker_first: true,
        },
        durableObjects: {
          AGENT: { className: "Agent", useSQLite: true },
          SANDBOX: { className: "Sandbox", useSQLite: true },
          CLAUDE_CODE: { className: "ClaudeCode", useSQLite: true },
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
