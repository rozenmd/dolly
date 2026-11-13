import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { headers, signIn } from "./session";

beforeEach(signIn);

describe("Hono Worker in workerd", () => {
  it("serves health without credentials and never caches responses", async () => {
    const response = await SELF.fetch("https://worker/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });
  it("rejects unauthenticated access to every protected operation", async () => {
    for (const [path, method] of [
      ["auth/codex", "GET"],
      ["auth/codex", "POST"],
      ["auth/codex", "DELETE"],
      ["sessions", "POST"],
      ["sessions/missing", "GET"],
      ["sessions/missing/events", "GET"],
      ["sessions/missing/messages", "POST"],
      ["sessions/missing/abort", "POST"],
      ["sessions/missing/children", "GET"],
      ["sessions/missing/children", "POST"],
      ["sessions/missing/children/child/messages", "POST"],
      ["sessions/missing/tasks/task", "GET"],
    ]) {
      expect((await SELF.fetch(`https://worker/api/${path}`, { method })).status).toBe(401);
    }
  });
  it("requires a subscription before creating a session", async () => {
    const response = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Connect your Codex subscription first" });
  });
  it("checks WebSocket upgrades, origins and missing sessions", async () => {
    const url = "https://worker/api/sessions/missing/events";
    expect((await SELF.fetch(url, { headers })).status).toBe(426);
    expect(
      (
        await SELF.fetch(url, {
          headers: { ...headers, Upgrade: "websocket", Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await SELF.fetch(url, {
          headers: { ...headers, Upgrade: "websocket", Origin: "https://worker" },
        })
      ).status,
    ).toBe(404);
  });
  it("rejects malformed session requests and unknown Codex models before creating a session", async () => {
    for (const body of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ model: 42 }),
      JSON.stringify({ model: null }),
      JSON.stringify({ model: "" }),
      JSON.stringify({ model: "not-a-codex-model" }),
    ]) {
      const response = await SELF.fetch("https://worker/api/sessions", {
        method: "POST",
        headers,
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Expected an optional model from the Codex catalog",
      });
    }
  });
  it("validates messages and returns 404 for unknown sessions", async () => {
    for (const body of [
      "not json",
      JSON.stringify({ content: "" }),
      JSON.stringify({ content: "hello", requestId: "bad" }),
    ]) {
      expect(
        (
          await SELF.fetch("https://worker/api/sessions/missing/messages", {
            method: "POST",
            headers,
            body,
          })
        ).status,
      ).toBe(400);
    }

    expect((await SELF.fetch("https://worker/api/sessions/missing", { headers })).status).toBe(404);
    expect(
      (
        await SELF.fetch("https://worker/api/sessions/missing/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({ content: "hello", requestId: crypto.randomUUID() }),
        })
      ).status,
    ).toBe(404);
  });
  it("bounds request bodies", async () => {
    expect(
      (
        await SELF.fetch("https://worker/api/sessions/missing/messages", {
          method: "POST",
          headers,
          body: "x".repeat(65_537),
        })
      ).status,
    ).toBe(413);
  });
});
