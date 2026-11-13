import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { webPlugins } from "../../web/vite.config.ts";

// HTTP/SSR tests do not launch containers. The production build and sandbox suite retain them.
export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: (config) => ({
        ...config,
        containers: [],
        worker: {
          ...config.worker,
          env: {
            ...config.worker.env,
            ACCESS_LOCAL_DEV: { type: "text", value: "true" },
            API_TOKEN: { type: "text", value: "test-token-with-at-least-32-characters" },
            WORKSPACES: {
              type: "artifacts",
              namespace: "test-web-workspaces",
              dev: { remote: false },
            },
          },
          exports: {
            ...config.worker.exports,
            Sandbox: { type: "durable-object", storage: "sqlite" },
          },
        },
      }),
    }),
    ...webPlugins("web/src"),
  ],
});
