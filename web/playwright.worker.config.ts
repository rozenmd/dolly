import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:8787" },
  webServer: {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    command:
      "pnpm exec vp -C . preview --config test/worker/vite.config.ts --host 127.0.0.1 --port 8787",
    url: "http://127.0.0.1:8787",
    reuseExistingServer: false,
  },
});
