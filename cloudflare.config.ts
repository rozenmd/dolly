import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { readAccessSettings } from "./scripts/access-settings.ts";

const workerName = "pi-hard";
const access = readAccessSettings();

const sandbox = defineContainer({
  name: "pi-hard-sandbox",
  schedulingPolicy: "durable-object",
  images: { sandbox: { dockerfile: "./Dockerfile" } },
});

export default defineConfig({
  worker: {
    name: workerName,
    previewUrls: false,
    entrypoint: "./src/worker.ts",
    assets: { runWorkerFirst: true },
    compatibilityDate: "2026-11-10",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      ASSETS: bindings.assets(),
      WORKSPACES: bindings.artifacts({ namespace: "pi-hard-workspaces" }),
      ACCESS_TEAM_DOMAIN: bindings.text(access.ACCESS_TEAM_DOMAIN),
      ACCESS_AUD: bindings.text(access.ACCESS_AUD),
      ACCESS_LOCAL_DEV: bindings.text("false"),
      CODEX_MODEL: bindings.text("gpt-6-luna"),
      AGENT: bindings.durableObject({ worker: workerName, exportName: "Agent" }),
      SANDBOX: bindings.durableObject({ worker: workerName, exportName: "Sandbox" }),
    },
    exports: {
      GitHubIngress: exports.worker(),
      WorkspaceOutbound: exports.worker(),
      Agent: exports.durableObject({ storage: "sqlite" }),
      Sandbox: exports.durableObject({ storage: "sqlite", container: sandbox }),
    },
    observability: { enabled: true },
  },
  containers: [sandbox],
});
