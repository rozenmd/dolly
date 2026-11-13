import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { webPlugins } from "./web/vite.config.ts";

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), ...webPlugins("web/src")],
});
