import { env } from "cloudflare:workers";
import {
  SELF,
  runInDurableObject,
  reset,
  evictDurableObject,
  abortAllDurableObjects,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as Schema from "effect/Schema";
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
const auth = () => SELF.fetch("https://worker/api/auth/chatgpt", { headers });

beforeEach(async () => {
  await reset();
  await signIn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Awaiting = { state: "awaiting_redirect"; authorizeUrl: string; redirectUri: string };

const start = async () =>
  await (
    await SELF.fetch("https://worker/api/auth/chatgpt", { method: "POST", headers })
  ).json<Awaiting>();

const complete = (callbackUrl: string) =>
  SELF.fetch("https://worker/api/auth/chatgpt", {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl }),
  });

/** The address ChatGPT redirects to after approval, for the attempt behind `authorizeUrl`. */
const redirected = (authorizeUrl: string, params: Record<string, string> = {}) => {
  const url = new URL("http://127.0.0.1:1455/auth/callback");
  url.search = new URLSearchParams({
    code: "private-code",
    state: new URL(authorizeUrl).searchParams.get("state") ?? "",
    client_id: "app_dolly_registered",
    ...params,
  }).toString();

  return url.toString();
};

const tokens = {
  access_token: jwt,
  refresh_token: "private-refresh",
  id_token: jwt,
  expires_in: 3600,
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
};

describe("Sign in with ChatGPT", () => {
  it("registers Dolly as a connected app, resumes after a crash, exchanges the pasted redirect and logs out without returning tokens", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const awaiting = await start();
    expect(awaiting).toMatchObject({
      state: "awaiting_redirect",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
    });
    // Starting needs no network: the authorize URL is built locally.
    expect(fetch).toHaveBeenCalledTimes(0);
    const authorize = new URL(awaiting.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://auth.openai.com/api/accounts/authorize",
    );
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Dolly",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      resource: "https://api.openai.com/v1",
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      code_challenge_method: "S256",
    });
    expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    await abortAllDurableObjects();
    // The pending attempt survives a restart and is resumed rather than replaced.
    expect(await (await auth()).json()).toEqual(awaiting);
    expect((await start()).authorizeUrl).toBe(awaiting.authorizeUrl);
    fetch.mockImplementationOnce(async () => json(tokens));
    const result = await complete(redirected(awaiting.authorizeUrl));
    expect(await result.json()).toEqual({ state: "connected" });
    const exchange = fetch.mock.calls.at(-1);
    expect(String(exchange?.[0])).toBe("https://auth.openai.com/api/accounts/oauth/token");
    const body = new URLSearchParams(await new Response(exchange?.[1]?.body).text());
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      client_id: "app_dolly_registered",
      code: "private-code",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      resource: "https://api.openai.com/v1",
    });
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      expect(await state.storage.get("credential:openai")).toMatchObject({
        type: "oauth",
        refresh: "private-refresh",
        clientId: "app_dolly_registered",
      });
      expect(await state.storage.get("login")).toBeUndefined();
    });
    const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: string }>();
    expect((await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).status).toBe(200);
    expect(
      await (
        await SELF.fetch("https://worker/api/auth/chatgpt", { method: "DELETE", headers })
      ).json(),
    ).toEqual({ state: "not_connected" });
    expect(await (await auth()).json()).toEqual({ state: "not_connected" });
    // The installation keeps one agent host ID across sign-ins.
    const again = new URL((await start()).authorizeUrl).searchParams;
    expect(again.get("ext_agent_host_id")).toBe(authorize.searchParams.get("ext_agent_host_id"));
    expect(again.get("state")).not.toBe(authorize.searchParams.get("state"));
  });

  it("rejects pasted addresses that do not belong to this attempt without calling OpenAI", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { authorizeUrl } = await start();

    for (const [input, error] of [
      ["not a url", "Paste the full address"],
      ["https://example.com/auth/callback?code=x", "must start with http://127.0.0.1:1455"],
      [redirected(authorizeUrl, { state: "other" }), "different sign-in attempt"],
      [redirected(authorizeUrl, { error: "access_denied" }), "access_denied"],
      [redirected(authorizeUrl, { code: "" }), "no authorization code"],
      [redirected(authorizeUrl, { client_id: "" }), "registered client ID"],
    ] as const) {
      const response = await complete(input);
      expect(response.status).toBe(400);
      expect((await response.json<{ error: string }>()).error).toContain(error);
    }

    expect(fetch).toHaveBeenCalledTimes(0);
    expect(await (await auth()).json()).toMatchObject({ state: "awaiting_redirect" });

    const malformed = await SELF.fetch("https://worker/api/auth/chatgpt", {
      method: "PUT",
      headers,
      body: "{}",
    });

    expect(malformed.status).toBe(400);
  });

  it("refuses a grant without token sharing and ends the attempt", async () => {
    const { authorizeUrl } = await start();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () =>
      json({ ...tokens, scope: "openid profile email" }),
    );
    const response = await complete(redirected(authorizeUrl));
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain(
      "without permission to use your ChatGPT plan",
    );
    expect(await (await auth()).json()).toEqual({ state: "not_connected" });
  });

  it("never exposes upstream token response bodies on failure", async () => {
    const { authorizeUrl } = await start();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json({ refresh_token: "private-refresh" }, 500),
    );
    const response = await complete(redirected(authorizeUrl));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("HTTP 500");
    expect(text).not.toContain("private-refresh");
  });

  it("expires old attempts", async () => {
    await start();
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      const login = await state.storage.get<{
        state: string;
        verifier: string;
        authorizeUrl: string;
      }>("login");

      await state.storage.put("login", { ...login, expiresAt: 0 });
    });
    expect(await (await auth()).json()).toEqual({ state: "expired" });
    expect(await (await auth()).json()).toEqual({ state: "not_connected" });
  });

  it("releases RPC handles so an idle account can be evicted cleanly", async () => {
    await start();
    await evictDurableObject(env.AGENT.getByName("owner"));
    expect(await (await auth()).json()).toMatchObject({ state: "awaiting_redirect" });
  });
});

describe("credential ownership", () => {
  it("serializes competing refresh writers and keeps the rotated token through eviction", async () => {
    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      const store = new Credentials(state.storage);
      await store.modify("openai", async () => ({
        type: "oauth",
        access: "a",
        refresh: "r0",
        expires: 0,
      }));
      const seen: string[] = [];
      await Promise.all(
        [1, 2].map((number) =>
          store.modify("openai", async (current) => {
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
      expect(await new Credentials(state.storage).read("openai")).toMatchObject({
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

it("refreshes with the registered client under the same credential lock", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(Object.fromEntries(new URLSearchParams(await new Response(init?.body).text()))).toEqual({
      grant_type: "refresh_token",
      client_id: "app_dolly_registered",
      refresh_token: "old-refresh",
      resource: "https://api.openai.com/v1",
    });

    // Refresh responses may omit scope; the stored grant keeps its scopes.
    return json({ access_token: jwt, refresh_token: "rotated-refresh", expires_in: 3600 });
  });

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const { createModels } = await import("@earendil-works/pi-ai/models");
    const { chatgptProvider } = await import("../src/chatgpt-login");
    const store = new Credentials(state.storage);
    await store.modify("openai", async () => ({
      type: "oauth",
      access: "expired-access",
      refresh: "old-refresh",
      expires: 0,
      clientId: "app_dolly_registered",
      scopes: ["chatgpt.tokens.use.direct"],
    }));
    const models = createModels({ credentials: store });
    models.setProvider(chatgptProvider());

    const results = await Promise.all([models.getAuth("openai"), models.getAuth("openai")]);

    expect(results.map((result) => result?.auth.apiKey)).toEqual([jwt, jwt]);
    expect(await store.read("openai")).toMatchObject({
      refresh: "rotated-refresh",
      clientId: "app_dolly_registered",
    });
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
