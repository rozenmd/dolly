import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("requires Cloudflare Access for the page, assets, and API even with a valid bearer token", async () => {
  for (const path of [
    "/",
    "/assets/missing.js",
    "/api/auth/codex",
    "/unknown",
    "/api/setup/github/callback",
    `/api/setup/github/${"a".repeat(43)}`,
  ]) {
    const response = await SELF.fetch(`https://worker${path}`, {
      headers: { Authorization: "Bearer test-token-with-at-least-32-characters" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Cloudflare Access authentication required" });
  }
});
