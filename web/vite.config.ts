import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export function webPlugins(srcDirectory = "src") {
  return [tanstackStart({ srcDirectory }), react()];
}

export default defineConfig({
  plugins: webPlugins(),
  server: {
    host: "127.0.0.1",
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true, ws: true } },
  },
});
