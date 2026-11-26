import { defineConfig } from "vite-plus";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { TimingSequencer } from "./scripts/ci-sequencer";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-11-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ACCESS_LOCAL_DEV: "true",
          PR_SCREENSHOTS_URL: "https://public-test.r2.dev",
        },
        r2Buckets: ["SCREENSHOTS", "PR_SCREENSHOTS", "DEPENDENCY_CACHE"],
        durableObjects: {
          AGENT: { className: "Agent", useSQLite: true },
          SANDBOX: { className: "Sandbox", useSQLite: true },
          CLAUDE_CODE: { className: "ClaudeCode", useSQLite: true },
        },
      },
      config: false,
    }),
  ],
  test: {
    sequence: { sequencer: TimingSequencer },
    include: ["test/*.test.ts"],
    // Avoid oversized warm-module WebSocket frames (workers-sdk#16349).
    fsModuleCache: false,
  },
});
