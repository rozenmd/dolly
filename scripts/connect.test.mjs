import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import * as Schema from "effect/Schema";

const token = "test-connect-token-at-least-32-characters";

async function connect(url, access = {}) {
  const child = spawn(process.execPath, ["scripts/connect.mjs"], {
    env: { ...process.env, API_URL: url, API_TOKEN: token, ...access, NO_COLOR: "1" },
    signal: AbortSignal.timeout(5000),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "close");

  return { code, output };
}

test("the Effect login client prints the device code, polls and connects without exposing the bearer token", async (t) => {
  const requests = [];

  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
      path: request.url,
      clientId: request.headers["cf-access-client-id"],
      clientSecret: request.headers["cf-access-client-secret"],
    });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.method === "POST"
          ? {
              state: "awaiting_code",
              verificationUri: "https://auth.openai.com/codex/device",
              userCode: "TEST-CODE",
              pollAfterSeconds: 1,
            }
          : { state: "connected" },
      ),
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );

  const result = await connect(`http://127.0.0.1:${address.port}`, {
    CF_ACCESS_CLIENT_ID: "test-access-id",
    CF_ACCESS_CLIENT_SECRET: "test-access-secret",
  });

  assert.equal(result.code, 0);
  assert.match(result.output, /TEST-CODE/);
  assert.match(result.output, /Codex subscription connected/);
  assert.ok(!result.output.includes(token));
  assert.ok(!result.output.includes("test-access-secret"));
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "GET"],
  );
  assert.ok(
    requests.every(
      ({ authorization, path, clientId, clientSecret }) =>
        authorization === `Bearer ${token}` &&
        path === "/api/auth/codex" &&
        clientId === "test-access-id" &&
        clientSecret === "test-access-secret",
    ),
  );
});

test("the login client rejects insecure remote URLs before sending credentials", async () => {
  const result = await connect("http://example.invalid");
  assert.equal(result.code, 1);
  assert.match(result.output, /Use HTTPS/);
  assert.ok(!result.output.includes(token));
});

test("the login client rejects partial Access service credentials before sending requests", async () => {
  const result = await connect("http://127.0.0.1:1", {
    CF_ACCESS_CLIENT_ID: "test-access-id",
    CF_ACCESS_CLIENT_SECRET: "",
  });

  assert.equal(result.code, 1);
  assert.match(result.output, /Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
});
