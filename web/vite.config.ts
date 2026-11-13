import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [tanstackStart(), react()],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
});
