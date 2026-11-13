import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { authorizeAccess } from "../src/access";
import app from "../src/index";
import { headers as signedIn, signIn } from "./session";

const team = "example-team.cloudflareaccess.com";
const audience = "test-access-application-audience";
let privateKey: JsonWebKey & { kid: string };
let publicKey: JsonWebKey & { kid: string };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  if (!("privateKey" in pair)) throw new Error("Expected an RSA key pair");

  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

  if (privateJwk instanceof ArrayBuffer || publicJwk instanceof ArrayBuffer)
    throw new Error("Expected exported JWKs");

  privateKey = {
    ...privateJwk,
    kid: "access-test",
    alg: "RS256",
  };
  publicKey = {
    ...publicJwk,
    kid: "access-test",
    alg: "RS256",
  };
});

beforeEach(signIn);

afterEach(() => vi.restoreAllMocks());

function claims() {
  return { iss: `https://${team}`, aud: [audience], exp: Math.floor(Date.now() / 1000) + 300 };
}

function request(
  assertion?: string,
  overrides: Partial<typeof env> = {},
  cookie = signedIn.Cookie,
) {
  const headers = new Headers({ Cookie: cookie });

  if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);

  return app.request(
    "https://worker/api/sessions/missing",
    { headers },
    {
      ...env,
      ACCESS_TEAM_DOMAIN: team,
      ACCESS_AUD: audience,
      ACCESS_LOCAL_DEV: "false",
      ...overrides,
    },
  );
}

function certificates() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe(`https://${team}/cdn-cgi/access/certs`);
    expect(init?.redirect).toBe("manual");

    return Response.json({ keys: [publicKey] });
  });
}

it("requires Access even with a signed-in session, and fails closed when configuration is missing or unsafe", async () => {
  const fetch = certificates();
  expect((await request()).status).toBe(401);

  for (const overrides of [
    { ACCESS_TEAM_DOMAIN: "" },
    { ACCESS_AUD: "" },
    { ACCESS_TEAM_DOMAIN: "attacker.example" },
    { ACCESS_TEAM_DOMAIN: `${team}/redirect` },
    { ACCESS_LOCAL_DEV: undefined, ACCESS_AUD: "" },
  ]) {
    const response = await request("forged", overrides);
    expect(response.status).toBe(503);
  }

  expect(fetch).not.toHaveBeenCalled();
});

it("verifies the signature, issuer, audience and expiration before reaching the API", async () => {
  certificates();
  const jwt = await sign(claims(), privateKey, "RS256");
  expect((await request(jwt)).status).toBe(404);
  expect((await request(jwt, {}, "__Host-dolly-session=incorrect")).status).toBe(401);

  for (const payload of [
    { ...claims(), iss: "https://other.cloudflareaccess.com" },
    { ...claims(), aud: ["other-application"] },
    { ...claims(), exp: 1 },
    { iss: `https://${team}`, aud: [audience] },
    { ...claims(), nbf: Math.floor(Date.now() / 1000) + 600 },
  ]) {
    expect((await request(await sign(payload, privateKey, "RS256"))).status).toBe(401);
  }

  expect((await request(await sign(claims(), "attacker-controlled-key", "HS256"))).status).toBe(
    401,
  );
  const parts = jwt.split(".");
  parts[1] = btoa(JSON.stringify({ ...claims(), sub: "forged" })).replaceAll("=", "");
  expect((await request(parts.join("."))).status).toBe(401);
  expect((await request("not.a.jwt")).status).toBe(401);
});

it("fails closed on certificate errors without exposing assertions", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
  const jwt = await sign(claims(), privateKey, "RS256");
  const response = await request(jwt);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain(jwt);
});

it("rejects certificate redirects without following them", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toBe(`https://${team}/cdn-cgi/access/certs`);
    expect(init?.redirect).toBe("manual");

    return new Response(null, {
      status: 302,
      headers: { Location: "https://attacker.example/keys" },
    });
  });

  const response = await request(await sign(claims(), privateKey, "RS256"));
  expect(response.status).toBe(401);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("accepts signed string audiences from Access service tokens without weakening validation", async () => {
  certificates();
  const payload = { ...claims(), aud: audience };
  expect((await request(await sign(payload, privateKey, "RS256"))).status).toBe(404);

  for (const invalid of [
    { ...payload, aud: "other-application" },
    { ...payload, iss: "https://other.cloudflareaccess.com" },
    { ...payload, exp: 1 },
  ]) {
    expect((await request(await sign(invalid, privateKey, "RS256"))).status).toBe(401);
  }

  expect((await request(await sign(payload, "attacker-controlled-key", "HS256"))).status).toBe(401);
});

it("times out and aborts a stalled certificate fetch", async () => {
  const jwt = await sign(claims(), privateKey, "RS256");
  let aborted = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
        Effect.runSync(Deferred.succeed(started, undefined));

        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          ),
        );
      });

      const fiber = yield* Effect.forkChild(
        authorizeAccess(
          new Request("https://worker/api/sessions", {
            headers: { "Cf-Access-Jwt-Assertion": jwt },
          }),
          { ...env, ACCESS_LOCAL_DEV: "false", ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: audience },
        ),
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("6 seconds");
      expect(yield* Fiber.join(fiber)).toBe("denied");
      expect(aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
