import { createPrivateKey } from "node:crypto";
import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Schema from "effect/Schema";
import { DEVICE_FLOW_DISABLED } from "../src/github-auth";

const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

if (!("privateKey" in keys)) throw new Error("Expected an RSA key pair");

const exported = await crypto.subtle.exportKey("pkcs8", keys.privateKey);

if (!(exported instanceof ArrayBuffer)) throw new Error("Expected PKCS8 bytes");

const pem = createPrivateKey(
  `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(exported)))}\n-----END PRIVATE KEY-----`,
)
  .export({ type: "pkcs1", format: "pem" })
  .toString();

const app = {
  id: 42,
  slug: "dolly-test",
  pem,
  client_id: "app-client-id",
  webhook_secret: "private-webhook-secret-at-least-32-characters",
  owner: { login: "octocat", type: "User" },
};

const json = (value: Schema.Json, status = 200) => Response.json(value, { status });

const deviceCode = {
  device_code: "private-device-code",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function cookie(response: Response, name: string) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";")[0];
}

async function connectApp() {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("github:connected", { app });
  });
}

async function due() {
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    for (const [key, value] of await state.storage.list<object>({ prefix: "auth:device:" }))
      await state.storage.put(key, { ...value, nextPollAt: 0 });
  });
}

/** Start a device sign-in and approve it on "GitHub" as the given user. */
async function signInAs(user: { id: number; login: string }) {
  let fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url, init) => {
    expect(String(url)).toBe("https://github.com/login/device/code");
    expect(init?.redirect).toBe("manual");
    expect(String(init?.body)).toBe("client_id=app-client-id");

    return json(deviceCode);
  });

  const start = await SELF.fetch("https://worker/api/auth/github", { method: "POST" });
  expect(await start.json()).toMatchObject({ state: "awaiting_code", userCode: "WDJB-MJHT" });
  const device = cookie(start, "__Host-dolly-github-device");
  expect(device).toBeDefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockRestore();

  const poll = () =>
    SELF.fetch("https://worker/api/auth/github", { headers: { Cookie: device ?? "" } });

  fetch = vi.spyOn(globalThis, "fetch");
  expect(await (await poll()).json()).toMatchObject({ state: "awaiting_code" });
  expect(fetch).not.toHaveBeenCalled();
  await due();
  fetch.mockImplementationOnce(async () => json({ error: "authorization_pending" }));
  expect(await (await poll()).json()).toMatchObject({ state: "awaiting_code" });
  await due();
  fetch.mockImplementationOnce(async (url, init) => {
    expect(String(url)).toBe("https://github.com/login/oauth/access_token");
    expect(init?.redirect).toBe("manual");
    expect(String(init?.body)).toContain("device_code=private-device-code");

    return json({ access_token: "private-user-token", token_type: "bearer" });
  });
  fetch.mockImplementationOnce(async (url, init) => {
    expect(String(url)).toBe("https://api.github.com/user");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-user-token");

    return json(user);
  });

  const result = await poll();
  fetch.mockRestore();

  return result;
}

beforeEach(async () => {
  await reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub sign-in", () => {
  it("rejects a redirected device-code response even when its JSON looks valid", async () => {
    await connectApp();

    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://github.com/login/device/code");
      expect(init?.redirect).toBe("manual");

      return Response.json(deviceCode, {
        status: 302,
        headers: { Location: "https://attacker.example/device" },
      });
    });

    const result = await SELF.fetch("https://worker/api/auth/github", { method: "POST" });
    expect(result.status).toBe(409);
    expect(await result.clone().text()).toContain("unexpected redirect");
    expect(cookie(result, "__Host-dolly-github-device")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  for (const redirected of ["token", "user"]) {
    it(`rejects a redirected ${redirected} response without creating a session`, async () => {
      await connectApp();

      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementationOnce(async () => json(deviceCode));

      const start = await SELF.fetch("https://worker/api/auth/github", { method: "POST" });
      const device = cookie(start, "__Host-dolly-github-device");
      expect(device).toBeDefined();
      await due();
      fetch.mockClear();
      fetch.mockImplementation(async (url, init) => {
        expect(init?.redirect).toBe("manual");

        if (String(url) === "https://github.com/login/oauth/access_token")
          return Response.json(
            { access_token: "private-user-token", token_type: "bearer" },
            redirected === "token"
              ? { status: 307, headers: { Location: "https://attacker.example/token" } }
              : { status: 200 },
          );

        expect(String(url)).toBe("https://api.github.com/user");

        return Response.json(
          { id: 7, login: "octocat" },
          { status: 302, headers: { Location: "https://attacker.example/user" } },
        );
      });

      const result = await SELF.fetch("https://worker/api/auth/github", {
        headers: { Cookie: device ?? "" },
      });

      expect(result.status).toBe(502);
      expect(cookie(result, "__Host-dolly-session")).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(redirected === "token" ? 1 : 2);
      expect(await (await SELF.fetch("https://worker/api/auth")).json()).toMatchObject({
        ownerClaimed: false,
        user: null,
      });
    });
  }

  it("lets Cloudflare Access alone start GitHub App setup only until someone owns dolly", async () => {
    const setup = () =>
      SELF.fetch("https://worker/api/integrations/github/setup", {
        method: "POST",
        body: JSON.stringify({
          owner: "octocat",
          ownerType: "personal",
          ingress: "https://ingress.example/hooks/github",
        }),
      });

    expect((await setup()).status).toBe(200);
    expect(await (await SELF.fetch("https://worker/api/auth")).json()).toMatchObject({
      github: { connected: false },
      ownerClaimed: false,
      user: null,
    });
    await connectApp();
    expect((await signInAs({ id: 7, login: "octocat" })).status).toBe(200);
    expect((await setup()).status).toBe(401);
  });

  it("makes the first GitHub account the owner and gives that browser a session", async () => {
    await connectApp();
    expect((await SELF.fetch("https://worker/api/sessions/missing")).status).toBe(401);

    const result = await signInAs({ id: 7, login: "octocat" });
    expect(await result.clone().json()).toEqual({ state: "signed_in", login: "octocat" });
    expect(await result.clone().text()).not.toContain("private-user-token");
    const session = cookie(result, "__Host-dolly-session");
    expect(session).toBeDefined();
    expect(result.headers.getSetCookie().join("\n")).toMatch(/HttpOnly/);

    const headers = { Cookie: session ?? "" };
    expect((await SELF.fetch("https://worker/api/sessions/missing", { headers })).status).toBe(404);
    expect(await (await SELF.fetch("https://worker/api/auth", { headers })).json()).toMatchObject({
      ownerClaimed: true,
      user: { login: "octocat" },
    });

    await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
      const stored = JSON.stringify([...(await state.storage.list())]);
      expect(stored).not.toContain("private-user-token");
      expect(stored).not.toContain(session?.split("=")[1]);
    });

    const signedOut = await SELF.fetch("https://worker/api/auth/session", {
      method: "DELETE",
      headers,
    });

    expect(signedOut.status).toBe(200);
    expect((await SELF.fetch("https://worker/api/sessions/missing", { headers })).status).toBe(401);
  });

  it("refuses any other GitHub account once dolly has an owner", async () => {
    await connectApp();
    await signInAs({ id: 7, login: "octocat" });

    const result = await signInAs({ id: 8, login: "intruder" });
    expect(result.status).toBe(403);
    expect(await result.clone().json()).toEqual({
      state: "denied",
      message: "You signed in as @intruder, but this dolly belongs to @octocat.",
    });
    expect(cookie(result, "__Host-dolly-session")).toBeUndefined();
  });

  it("explains how to turn on device flow when GitHub has it disabled", async () => {
    await connectApp();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () =>
      json({ error: "device_flow_disabled" }, 400),
    );

    const start = await SELF.fetch("https://worker/api/auth/github", { method: "POST" });
    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({ error: DEVICE_FLOW_DISABLED });
  });

  it("points the GitHub App webhook at a new ingress URL without leaving dolly", async () => {
    await connectApp();
    const session = cookie(await signInAs({ id: 7, login: "octocat" }), "__Host-dolly-session");
    const headers = { Cookie: session ?? "" };

    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://api.github.com/app/hook/config");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://new-ingress.example/hooks/github",
        content_type: "json",
        secret: app.webhook_secret,
        insecure_ssl: "0",
      });

      return json({ url: "https://new-ingress.example/hooks/github" });
    });

    const invalid = await SELF.fetch("https://worker/api/integrations/github/ingress", {
      method: "PUT",
      headers,
      body: JSON.stringify({ url: "http://insecure.example" }),
    });

    expect(invalid.status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();

    const updated = await SELF.fetch("https://worker/api/integrations/github/ingress", {
      method: "PUT",
      headers,
      body: JSON.stringify({ url: "https://new-ingress.example/" }),
    });

    expect(await updated.json()).toEqual({ ingress: "https://new-ingress.example/hooks/github" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      await (await SELF.fetch("https://worker/api/integrations/github", { headers })).json(),
    ).toMatchObject({
      ingress: "https://new-ingress.example/hooks/github",
      settingsUrl: "https://github.com/settings/apps/dolly-test",
    });
  });
});
