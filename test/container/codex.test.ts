import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type { Codex } from "../../src/codex";
import { zstdCompressSync } from "node:zlib";

declare global {
  namespace Cloudflare {
    interface Env {
      CODEX_CONTAINER: DurableObjectNamespace<Codex>;
    }
  }
}

it("runs the Codex bridge through its real container without exposing malformed credentials", async () => {
  const codex = env.CODEX_CONTAINER.getByName(crypto.randomUUID());
  const url = "https://chatgpt.com/backend-api/codex/responses";

  expect((await codex.fetch(url)).status).toBe(404);
  expect((await codex.fetch(url, { method: "POST", body: "{}" })).status).toBe(401);

  const secret = "not-a-jwt-fixture-secret";

  const result = await codex.fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "gpt-6-luna", input: [], tools: [] }),
  });

  expect(result.status).toBe(200);
  expect(result.headers.get("content-type")).toBe("text/event-stream");
  const text = await result.text();

  expect(text).toContain("Codex CLI request failed");
  expect(text).not.toContain(secret);

  const compressed = await codex.fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "content-encoding": "zstd" },
    body: new Uint8Array(
      zstdCompressSync(JSON.stringify({ model: "gpt-6-luna", input: [], tools: [] })),
    ),
  });

  expect(await compressed.text()).toContain("Codex CLI request failed");

  const id = crypto.randomUUID();

  await codex.cancel(id);

  const cancelled = await codex.fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "x-dolly-request-id": id },
    body: JSON.stringify({ model: "gpt-6-luna", input: [], tools: [] }),
  });

  expect(cancelled.status).toBe(499);
});
