import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

const token = "test-connect-token-at-least-32-characters";
async function connect(url) {
  const child = spawn(process.execPath, ["scripts/connect.mjs"], {
    env: { ...process.env, API_URL: url, API_TOKEN: token, NO_COLOR: "1" },
    signal: AbortSignal.timeout(5000),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  return { code, output };
}

test("the Effect login client prints the device code, polls and connects without exposing the bearer token", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, authorization: request.headers.authorization, path: request.url });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.method === "POST"
      ? { state: "awaiting_code", verificationUri: "https://auth.openai.com/codex/device", userCode: "TEST-CODE", pollAfterSeconds: 1 }
      : { state: "connected" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await connect(`http://127.0.0.1:${address.port}`);
  assert.equal(result.code, 0);
  assert.match(result.output, /TEST-CODE/);
  assert.match(result.output, /Codex subscription connected/);
  assert.ok(!result.output.includes(token));
  assert.deepEqual(requests.map(({ method }) => method), ["POST", "GET"]);
  assert.ok(requests.every(({ authorization, path }) => authorization === `Bearer ${token}` && path === "/api/auth/codex"));
});

test("the login client rejects insecure remote URLs before sending credentials", async () => {
  const result = await connect("http://example.invalid");
  assert.equal(result.code, 1);
  assert.match(result.output, /Use HTTPS/);
  assert.ok(!result.output.includes(token));
});
