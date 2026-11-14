import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { readAccessSettings } from "./scripts/access-settings.ts";
import { screenshotsBucket } from "./infra/screenshots.ts";

const workerName = "dolly";
const access = readAccessSettings();

const sandbox = defineContainer({
  name: "dolly-sandbox",
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
      SCREENSHOTS: bindings.r2({ name: screenshotsBucket.name }),
      BROWSER: bindings.browser(),
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
      PreviewOutbound: exports.worker(),
      Agent: exports.durableObject({ storage: "sqlite" }),
      Sandbox: exports.durableObject({ storage: "sqlite", container: sandbox }),
    },
    observability: { enabled: true },
  },
  containers: [sandbox],
});
