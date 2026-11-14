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
