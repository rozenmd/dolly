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
  const health = await SELF.fetch("https://worker/api/health");
  expect(await health.json()).toEqual({ ok: true });
  const missing = await SELF.fetch("https://worker/assets/missing.js");
  expect(missing.status).toBe(404);
});

it("routes GitHub App setup links and callbacks through Hono without a bearer token", async () => {
  const started = await SELF.fetch("https://worker/api/integrations/github/setup", {
    method: "POST",
    headers: { Authorization: "Bearer test-token-with-at-least-32-characters" },
    body: JSON.stringify({ owner: "example", ownerType: "personal" }),
  });

  expect(started.status).toBe(200);
  const { setupUrl } = await started.json<{ setupUrl: string }>();
  expect(new URL(setupUrl).pathname).toMatch(/^\/api\/setup\/github\/[A-Za-z0-9_-]{43}$/);
  const setup = await SELF.fetch(setupUrl);
  expect(setup.status).toBe(200);
  expect(setup.headers.get("content-type")).toContain("text/html");
  expect(setup.headers.get("referrer-policy")).toBe("no-referrer");
  expect(setup.headers.get("content-security-policy")).toContain("form-action https://github.com");
  const html = await setup.text();
  expect(html).toContain("Create GitHub App");
  expect(html).toContain("https://worker/api/setup/github/callback");

  const callback = await SELF.fetch("https://worker/api/setup/github/callback");
  expect(callback.status).toBe(400);
  expect(await callback.json()).toEqual({ error: "Invalid GitHub callback" });
});

it("does not expose backend handlers outside /api", async () => {
  for (const path of ["/health", "/setup/github/callback", `/setup/github/${"a".repeat(43)}`]) {
    const response = await SELF.fetch(`https://worker${path}`);
    expect(response.status).toBe(404);
  }
});
