import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "pi-hard-ingress",
    entrypoint: "../src/ingress.ts",
    previewUrls: false,
    compatibilityDate: "2026-11-10",
    compatibilityFlags: ["nodejs_compat"],
    env: { INGRESS: bindings.worker({ worker: "pi-hard", exportName: "GitHubIngress" }) },
    observability: { enabled: true },
  },
});
