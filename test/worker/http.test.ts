import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves the rendered workspace at the Worker root and its real bundled assets", async () => {
  const response = await SELF.fetch("https://worker/");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  expect(html).toContain("pi-hard");
  const stylesheet = html.match(/href="([^"]+\.css)"/);
  expect(stylesheet).not.toBeNull();

  if (!stylesheet) throw new Error("Rendered page did not link a stylesheet");
  const asset = await SELF.fetch(new URL(stylesheet[1], "https://worker"));
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("text/css");
});

it("keeps API authentication and JSON responses separate from frontend routing", async () => {
  const denied = await SELF.fetch("https://worker/api/auth/codex");
  expect(denied.status).toBe(401);

  const authorized = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer test-token-with-at-least-32-characters" },
  });

  expect(authorized.status).toBe(409);
  expect(await authorized.json()).toEqual({ error: "Connect your Codex subscription first" });

  const unknown = await SELF.fetch("https://worker/api/missing", {
    headers: { Authorization: "Bearer test-token-with-at-least-32-characters" },
  });

  expect(unknown.status).toBe(404);
  expect(await unknown.text()).not.toContain("<html");
});

it("preserves the public health endpoint and missing asset status", async () => {
  const health = await SELF.fetch("https://worker/health");
  expect(await health.json()).toEqual({ ok: true });
  const missing = await SELF.fetch("https://worker/assets/missing.js");
  expect(missing.status).toBe(404);
});
