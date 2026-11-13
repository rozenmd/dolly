import { env } from "cloudflare:workers";
import {
  SELF,
  runInDurableObject,
  reset,
  evictDurableObject,
  abortAllDurableObjects,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Schema from "effect/Schema";
import type { Device } from "../src/codex-login";
import type { Env as WorkerEnv } from "../src/env";
import { Credentials } from "../src/credentials";
import { exceptionDetails } from "../src/diagnostics";
import { headers, signIn } from "./session";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

const jwt = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.testsignature`;
const json = (value: Schema.Json, status = 200) => Response.json(value, { status });
const auth = () => SELF.fetch("https://worker/api/auth/codex", { headers });

beforeEach(async () => {
  await reset();
  await signIn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function due() {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const login = await state.storage.get<Device>("login");
    await state.storage.put("login", { ...login, nextPollAt: 0 });
  });
}

describe("Codex device login", () => {
  it("persists the grant through a crash, throttles polls, exchanges and logs out without returning tokens", async () => {
    let fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockImplementationOnce(async () =>
      json({ device_auth_id: "private-device-id", user_code: "TEST-CODE", interval: "5" }),
    );
    const start = await SELF.fetch("https://worker/api/auth/codex", { method: "POST", headers });
    expect(await start.json()).toMatchObject({ state: "awaiting_code", userCode: "TEST-CODE" });
    fetch.mockRestore();
    await abortAllDurableObjects();
    fetch = vi.spyOn(globalThis, "fetch");
    expect(await (await auth()).json()).toMatchObject({ state: "awaiting_code" });
    expect(fetch).toHaveBeenCalledTimes(0);
    await due();
    fetch.mockImplementationOnce(async () => json({}, 403));
    expect(await (await auth()).json()).toMatchObject({ state: "awaiting_code" });
    await due();
    fetch.mockImplementationOnce(async () =>
      json({ authorization_code: "private-code", code_verifier: "private-verifier" }),
    );
    fetch.mockImplementationOnce(async () =>
      json({ access_token: jwt, refresh_token: "private-refresh", expires_in: 3600 }),
    );
    const result = await auth();
    expect(await result.json()).toEqual({ state: "connected" });
    const exchange = fetch.mock.calls.at(-1);
    expect(String(exchange?.[0])).toBe("https://auth.openai.com/oauth/token");
    expect(await new Response(exchange?.[1]?.body).text()).toContain(
      "code_verifier=private-verifier",
    );
    const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: string }>();
    expect((await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).status).toBe(200);
    await abortAllDurableObjects();
    expect((await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).status).toBe(200);
    expect(
      await (
        await SELF.fetch("https://worker/api/auth/codex", { method: "DELETE", headers })
      ).json(),
    ).toEqual({ state: "not_connected" });
    expect(await (await auth()).json()).toEqual({ state: "not_connected" });
  });

  it("releases RPC handles so an idle account can be evicted cleanly", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ device_auth_id: "device", user_code: "CODE", interval: 5 }),
    );
    const response = await SELF.fetch("https://worker/api/auth/codex", { method: "POST", headers });
    expect(await response.json()).toMatchObject({ state: "awaiting_code" });
    await evictDurableObject(env.AGENT.getByName("owner"));
    expect(await (await auth()).json()).toMatchObject({ state: "awaiting_code" });
  });

  it("backs off on slow_down and expires old attempts", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockImplementationOnce(async () =>
      json({ device_auth_id: "device", user_code: "CODE", interval: 5 }),
    );
    await SELF.fetch("https://worker/api/auth/codex", { method: "POST", headers });
    await due();
    fetch.mockImplementationOnce(async () => json({ error: "slow_down" }, 429));
    expect(await (await auth()).json()).toMatchObject({
      state: "awaiting_code",
      pollAfterSeconds: 10,
    });
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      const login = await state.storage.get<Device>("login");
      await state.storage.put("login", { ...login, expiresAt: 0 });
    });
    expect(await (await auth()).json()).toEqual({ state: "expired" });
  });

  it("never exposes upstream token response bodies on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ refresh_token: "private-refresh" }, 500),
    );
    const response = await SELF.fetch("https://worker/api/auth/codex", { method: "POST", headers });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private-refresh");
  });
});

describe("credential ownership", () => {
  it("serializes competing refresh writers and keeps the rotated token through eviction", async () => {
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      const store = new Credentials(state.storage);
      await store.modify("openai-codex", async () => ({
        type: "oauth",
        access: "a",
        refresh: "r0",
        expires: 0,
      }));
      const seen: string[] = [];
      await Promise.all(
        [1, 2].map((number) =>
          store.modify("openai-codex", async (current) => {
            if (current?.type !== "oauth") throw new Error("Missing OAuth credential");
            seen.push(current.refresh);
            await Promise.resolve();

            return { ...current, refresh: `r${number}` };
          }),
        ),
      );
      expect(seen).toEqual(["r0", "r1"]);
    });
    await evictDurableObject(env.AGENT.getByName("owner"));
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      expect(await new Credentials(state.storage).read("openai-codex")).toMatchObject({
        refresh: "r2",
      });
    });
  });

  it("redacts secrets without dropping actionable exception details", () => {
    const result = exceptionDetails(
      new Error(`HTTP 401 invalid_grant refresh_token=private-refresh access_token=${jwt}`),
      ["private-refresh"],
    );

    expect(result.message).toContain("HTTP 401 invalid_grant");
    expect(JSON.stringify(result)).not.toContain(jwt);
    expect(JSON.stringify(result)).not.toContain("private-refresh");
  });
});

it("uses Pi's real refresh protocol under the same credential lock", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://auth.openai.com/oauth/token");
    expect(String(init?.body)).toContain("refresh_token=old-refresh");

    return json({ access_token: jwt, refresh_token: "rotated-refresh", expires_in: 3600 });
  });

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const { createModels } = await import("@earendil-works/pi-ai/models");
    const { openaiCodexProvider } = await import("@earendil-works/pi-ai/providers/openai-codex");
    const store = new Credentials(state.storage);
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: jwt,
      refresh: "old-refresh",
      expires: 0,
    }));
    const models = createModels({ credentials: store });
    models.setProvider(openaiCodexProvider());

    const results = await Promise.all([
      models.getAuth("openai-codex"),
      models.getAuth("openai-codex"),
    ]);

    expect(results.map((result) => result?.auth.apiKey)).toEqual([jwt, jwt]);
    expect(await store.read("openai-codex")).toMatchObject({ refresh: "rotated-refresh" });
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
