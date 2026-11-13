import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { sandboxTestConfig } from "./sandbox-config.ts";
import config from "../cloudflare.config.ts";

test("builds production Workers explicitly before prebuilt deployment or dry runs", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  const ingress = JSON.parse(
    await readFile(new URL("../ingress/package.json", import.meta.url), "utf8"),
  );

  assert.equal(root.scripts.deploy, "vite build && cf deploy --prebuilt");
  assert.equal(
    root.scripts.build,
    "vite build && cf deploy --prebuilt --dry-run && pnpm --dir ingress run build && pnpm --dir ingress exec cf deploy --prebuilt --dry-run",
  );
  assert.equal(ingress.scripts.build, "vite build");
  assert.equal(ingress.scripts.deploy, "pnpm run build && cf deploy --prebuilt");
});

test("typed Cloudflare config keeps SQLite namespaces and the sandbox image", () => {
  const { worker, containers } = config;
  assert.equal(worker.name, "dolly");
  assert.equal(worker.entrypoint, "./src/worker.ts");
  assert.deepEqual(worker.assets, { runWorkerFirst: true });
  assert.equal(worker.env.ASSETS.type, "assets");
  assert.deepEqual(worker.compatibilityFlags, ["nodejs_compat"]);
  assert.equal(
    worker.env.WORKSPACES?.type,
    process.env.DOLLY_LEGACY_ARTIFACTS === "true" ? "artifacts" : undefined,
  );
  assert.equal(worker.exports.WorkspaceOutbound.type, "worker");
  assert.equal(worker.previewUrls, false);
  assert.equal(worker.env.ACCESS_LOCAL_DEV.value, "false");
  assert.equal(worker.env.ACCESS_TEAM_DOMAIN.type, "text");
  assert.equal(worker.env.ACCESS_AUD.type, "text");
  assert.equal(worker.env.CODEX_MODEL.value, "gpt-6-luna");
  assert.deepEqual(worker.env.AGENT, {
    type: "durable-object",
    worker: worker.name,
    exportName: "Agent",
  });
  assert.deepEqual(worker.env.SANDBOX, {
    type: "durable-object",
    worker: worker.name,
    exportName: "Sandbox",
  });
  assert.equal(worker.exports.Agent.storage, "sqlite");
  assert.equal(worker.exports.Sandbox.storage, "sqlite");
  assert.equal(containers.length, 1);
  assert.equal(containers[0].name, "dolly-sandbox");
  assert.equal(worker.exports.Sandbox.container, containers[0]);
  assert.equal(containers[0].schedulingPolicy, "durable-object");
  assert.deepEqual(containers[0].images, { sandbox: { dockerfile: "./Dockerfile" } });
});

test("the sandbox test adapter retains the typed config's container link and image", async () => {
  const path = await sandboxTestConfig();
  const generated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(generated.main, "./src/index.ts");
  assert.equal(generated.exports.Sandbox.container, config.containers[0].name);
  assert.equal(generated.exports.Sandbox.storage, "sqlite");
  assert.equal(generated.containers[0].scheduling_policy, "durable_object");
  assert.deepEqual(generated.containers[0].images, config.containers[0].images);
  assert.deepEqual(
    generated.durable_objects.bindings.map(({ name, class_name }) => [name, class_name]),
    [
      ["AGENT", "Agent"],
      ["SANDBOX", "Sandbox"],
    ],
  );
});

test("public ingress binds only the private webhook entrypoint and has no credentials or Durable Object binding", async () => {
  const { default: ingress } = await import("../ingress/cloudflare.config.ts");
  assert.equal(ingress.worker.name, "dolly-ingress");
  assert.equal(ingress.worker.entrypoint, "../src/ingress.ts");
  assert.equal(ingress.worker.previewUrls, false);
  assert.deepEqual(Object.keys(ingress.worker.env), ["INGRESS"]);
  assert.deepEqual(ingress.worker.env.INGRESS, {
    type: "worker",
    worker: config.worker.name,
    exportName: "GitHubIngress",
  });
  assert.equal(config.worker.exports.GitHubIngress.type, "worker");
});
