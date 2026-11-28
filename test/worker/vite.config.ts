import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import { webPlugins } from "../../web/vite.config.ts";

const signedIn = process.env.DOLLY_DEV_SIGNED_IN === "1";

// HTTP/SSR tests and `pnpm dev:sandbox` do not launch containers. The production build and sandbox suite retain them.
export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // The seeded owner would replace a real local sign-in, so seeded mode keeps its own storage.
      ...(signedIn && { persistState: { path: ".cloudflare/dev-signed-in" } }),
      config: (config) => ({
        ...config,
        containers: [],
        worker: {
          ...config.worker,
          env: {
            ...config.worker.env,
            ACCESS_LOCAL_DEV: { type: "text", value: "true" },
            // `DOLLY_DEV_SIGNED_IN=1 pnpm dev:sandbox`: signed in with a seeded session (src/dev-seed.ts).
            ...(signedIn && {
              DEV_SIGNED_IN: { type: "text", value: "true" },
            }),
          },
          exports: {
            ...config.worker.exports,
            Sandbox: { type: "durable-object", storage: "sqlite" },
            ClaudeCode: { type: "durable-object", storage: "sqlite" },
          },
        },
      }),
    }),
    ...webPlugins("web/src"),
  ],
});
