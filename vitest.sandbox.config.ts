import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ config: "./cloudflare.config.ts" })],
  test: { include: ["test/container/*.test.ts"], testTimeout: 120_000 },
});
