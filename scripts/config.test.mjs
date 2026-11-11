import { strict as assert } from "node:assert";
import { test } from "node:test";
import config from "../cloudflare.config.ts";

test("typed Cloudflare config keeps SQLite namespaces and the native sandbox image", () => {
  const { worker, containers } = config;
  assert.equal(worker.name, "pi-hard");
  assert.equal(worker.entrypoint, "./src/index.ts");
  assert.deepEqual(worker.compatibilityFlags, ["nodejs_compat"]);
  assert.equal(worker.env.API_TOKEN.type, "secret");
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
  assert.equal(worker.exports.Sandbox.container, containers[0]);
  assert.equal(containers[0].schedulingPolicy, "durable-object");
  assert.deepEqual(containers[0].images, { sandbox: { dockerfile: "./Dockerfile" } });
});
