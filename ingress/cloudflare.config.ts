import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "dolly-ingress",
    entrypoint: "../src/ingress.ts",
    previewUrls: false,
    compatibilityDate: "2026-11-10",
    compatibilityFlags: ["nodejs_compat"],
    env: {
      INGRESS: bindings.worker({ worker: "dolly", exportName: "GitHubIngress" }),
      SLACK: bindings.worker({ worker: "dolly", exportName: "SlackIngress" }),
    },
    observability: { enabled: true, issues: { enabled: true } },
  },
});
