import { defineConfig } from "vite-plus";

// Browser tests drive Chrome over CDP; see e2e/browser/setup.ts for choosing the browser.
export default defineConfig({
  test: {
    include: ["e2e/**/*.spec.ts"],
    globalSetup: ["e2e/browser/setup.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
