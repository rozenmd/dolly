import { bindings, defineConfig, defineContainer, exports } from "cf/config";

const workerName = "pi-hard";

const sandbox = defineContainer({
  name: "pi-hard-sandbox",
  schedulingPolicy: "durable-object",
  images: { sandbox: { dockerfile: "./Dockerfile" } },
});

export default defineConfig({
  worker: {
    name: workerName,
    previewUrls: false,
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-11-10",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      API_TOKEN: bindings.secret(),
      ACCESS_TEAM_DOMAIN: bindings.text(""),
      ACCESS_AUD: bindings.text(""),
      ACCESS_LOCAL_DEV: bindings.text("false"),
      CODEX_MODEL: bindings.text("gpt-6-luna"),
      AGENT: bindings.durableObject({ worker: workerName, exportName: "Agent" }),
      SANDBOX: bindings.durableObject({ worker: workerName, exportName: "Sandbox" }),
    },
    exports: {
      Agent: exports.durableObject({ storage: "sqlite" }),
      Sandbox: exports.durableObject({ storage: "sqlite", container: sandbox }),
    },
    observability: { enabled: true },
  },
  containers: [sandbox],
});
