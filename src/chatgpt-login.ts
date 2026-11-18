import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { exceptionDetails, redact } from "./diagnostics";
import { Account } from "./credentials";
import { attempt, OperationError } from "./operations";
import { openaiIds } from "./models";
import { observeUsage } from "./usage";

type ResponsesStream = typeof streamSimple;

/**
 * Sign in with ChatGPT for third-party agents ("token sharing"). Each sign-in registers a
 * user-owned OAuth client named Dolly, which the ChatGPT account lists under Connected App
 * Limits. The resulting token calls the public Responses API at api.openai.com/v1 and is billed
 * to the ChatGPT plan, within the per-app limit the owner sets there.
 */
export const PROVIDER = "openai";
export const AGENT_NAME = "Dolly";
const AUTH = "https://auth.openai.com";
const TOKEN_URL = `${AUTH}/api/accounts/oauth/token`;

// Asking for this client ID makes OpenAI register a new client and return its ID on the callback.
const REGISTRATION_CLIENT_ID = "dynamic_agent_client";
export const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;

/**
 * The loopback redirect other agents register. Dolly runs in a Worker, so nothing listens here:
 * the browser shows a failed page and the owner pastes its address back into Dolly.
 */
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const LOGIN_KEY = "login";
const HOST_KEY = "chatgpt:host-id";
const LOGIN_TTL_MS = 10 * 60 * 1000;

// Refresh before the real expiry so no request starts with a token about to lapse.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

const PendingLogin = Schema.Struct({
  state: Schema.NonEmptyString,
  verifier: Schema.NonEmptyString,
  authorizeUrl: Schema.NonEmptyString,
  expiresAt: Schema.Finite,
});

type PendingLogin = typeof PendingLogin.Type;

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  scope: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
});

type Tokens = typeof Tokens.Type;

export const LoginCallback = Schema.Struct({
  callbackUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
});

export type ChatGPTCredential = OAuthCredential & {
  readonly clientId: string;
  readonly scopes: readonly string[];
};

export type LoginStatus =
  | { readonly state: "connected" | "not_connected" | "expired" }
  | {
      readonly state: "awaiting_redirect";
      readonly authorizeUrl: string;
      readonly redirectUri: string;
      readonly expiresAt: number;
    }
  | { readonly state: "error"; readonly error: string };

export class ChatGPTProtocol extends Context.Service<
  ChatGPTProtocol,
  {
    exchange(input: {
      code: string;
      verifier: string;
      clientId: string;
    }): Effect.Effect<Tokens, OperationError>;
    refresh(input: { refresh: string; clientId: string }): Effect.Effect<Tokens, OperationError>;
  }
>()("dolly/ChatGPTProtocol") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const http = HttpClient.withScope(yield* HttpClient.HttpClient);

      const decode = flow(
        Schema.decodeUnknownEffect(Tokens),
        Effect.mapError(
          () =>
            new OperationError({
              operation: "chatgpt.token",
              message: "Invalid ChatGPT token response",
              details: "Response values omitted because they can contain credentials",
            }),
        ),
      );

      const token = (body: URLSearchParams) =>
        Effect.gen(function* (): Effect.fn.Return<Tokens, OperationError, Scope.Scope> {
          const response = yield* http
            .execute(
              HttpClientRequest.post(TOKEN_URL).pipe(
                HttpClientRequest.setHeader("accept", "application/json"),
                HttpClientRequest.bodyText(body.toString(), "application/x-www-form-urlencoded"),
              ),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OperationError({
                    operation: "chatgpt.token",
                    message: "ChatGPT request failed",
                    details: exceptionDetails(cause),
                  }),
              ),
            );

          if (response.status < 200 || response.status >= 300)
            return yield* new OperationError({
              operation: "chatgpt.token",
              message: `ChatGPT returned HTTP ${response.status}`,
              details: { status: response.status },
            });

          return yield* response.json.pipe(
            Effect.mapError(
              () =>
                new OperationError({
                  operation: "chatgpt.token",
                  message: "ChatGPT returned invalid JSON",
                  details: { status: response.status },
                }),
            ),
            Effect.flatMap(decode),
          );
        }).pipe(
          Effect.scoped,
          Effect.timeout("15 seconds"),
          Effect.mapError((cause) =>
            cause instanceof OperationError
              ? cause
              : new OperationError({
                  operation: "chatgpt.token",
                  message: "ChatGPT request timed out",
                  details: exceptionDetails(cause),
                }),
          ),
        );

      return ChatGPTProtocol.of({
        exchange: ({ code, verifier, clientId }) =>
          token(
            new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              code,
              code_verifier: verifier,
              redirect_uri: REDIRECT_URI,
              resource: RESOURCE,
            }),
          ),
        refresh: ({ refresh, clientId }) =>
          token(
            new URLSearchParams({
              grant_type: "refresh_token",
              client_id: clientId,
              refresh_token: refresh,
              resource: RESOURCE,
            }),
          ),
      });
    }),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    // A Reference's default is cached. Resolve the host fetch at call time instead.
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (input, init) => globalThis.fetch(input, init)),
    ),
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
  );
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const randomValue = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** Credential from a token response; a grant without token sharing cannot call the API. */
export const toCredential = (tokens: Tokens, clientId: string, now: number) =>
  Effect.gen(function* () {
    const scopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);

    if (!scopes.includes(DIRECT_SCOPE))
      return yield* new OperationError({
        operation: "chatgpt.token",
        message:
          "ChatGPT sign-in finished without permission to use your ChatGPT plan; allow it when asked",
        details: { scopes },
      });

    return {
      type: "oauth",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: now + tokens.expires_in * 1000 - EXPIRY_MARGIN_MS,
      clientId,
      scopes,
    } satisfies ChatGPTCredential;
  });

const readPending = Effect.fn("ChatGPTLogin.readPending")(function* (
  storage: DurableObjectStorage,
) {
  const raw = yield* attempt("login.read", () => storage.get(LOGIN_KEY));

  return raw === undefined
    ? Option.none<PendingLogin>()
    : Schema.decodeUnknownOption(PendingLogin)(raw);
});

const awaiting = (pending: PendingLogin): LoginStatus => ({
  state: "awaiting_redirect",
  authorizeUrl: pending.authorizeUrl,
  redirectUri: REDIRECT_URI,
  expiresAt: pending.expiresAt,
});

/** OpenAI identifies each installation by a stable URI; keep one per Dolly owner. */
const hostId = Effect.fn("ChatGPTLogin.hostId")(function* (storage: DurableObjectStorage) {
  const stored = yield* attempt("login.host", () => storage.get<string>(HOST_KEY));

  if (stored) return stored;
  const created = `urn:uuid:${crypto.randomUUID()}`;
  yield* attempt("login.host", () => storage.put(HOST_KEY, created));

  return created;
});

export const startLogin = Effect.gen(function* () {
  const account = yield* Account;

  return yield* account.locked(
    Effect.gen(function* (): Effect.fn.Return<LoginStatus, OperationError> {
      if (Option.isSome(yield* account.get(PROVIDER))) return { state: "connected" };
      const now = yield* Clock.currentTimeMillis;
      const existing = yield* readPending(account.storage);

      if (Option.isSome(existing) && existing.value.expiresAt > now)
        return awaiting(existing.value);
      const verifier = randomValue();

      const challenge = base64url(
        new Uint8Array(
          yield* attempt("login.pkce", () =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
          ),
        ),
      );

      const state = randomValue();
      const url = new URL(`${AUTH}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: REGISTRATION_CLIENT_ID,
        agent_name_hint: AGENT_NAME,
        ext_agent_host_id: yield* hostId(account.storage),
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        state,
        nonce: randomValue(),
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

      const pending = {
        state,
        verifier,
        authorizeUrl: url.toString(),
        expiresAt: now + LOGIN_TTL_MS,
      };

      yield* attempt("login.write", () => account.storage.put(LOGIN_KEY, pending));

      return awaiting(pending);
    }),
  );
});

export const loginStatus = Effect.gen(function* () {
  const account = yield* Account;

  return yield* account.locked(
    Effect.gen(function* (): Effect.fn.Return<LoginStatus, OperationError> {
      if (Option.isSome(yield* account.get(PROVIDER))) return { state: "connected" };
      const pending = yield* readPending(account.storage);

      if (Option.isNone(pending)) return { state: "not_connected" };

      if (pending.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
        yield* attempt("login.delete", () => account.storage.delete(LOGIN_KEY));

        return { state: "expired" };
      }

      return awaiting(pending.value);
    }),
  );
});

/** Parse the pasted redirect. Failures are owner-correctable, so they return a status, not an error. */
function parseCallback(
  input: string,
  expectedState: string,
): { readonly error: string } | { readonly code: string; readonly clientId: string } {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    return { error: "Paste the full address from the browser's address bar." };
  }

  const expected = new URL(REDIRECT_URI);

  if (url.origin !== expected.origin || url.pathname !== expected.pathname)
    return { error: `The pasted address must start with ${REDIRECT_URI}` };
  const denied = url.searchParams.get("error");

  if (denied) return { error: `ChatGPT did not connect: ${denied.slice(0, 200)}` };

  if (url.searchParams.get("state") !== expectedState)
    return {
      error: "That address is from a different sign-in attempt. Start again.",
    };
  const code = url.searchParams.get("code");
  const clientId = url.searchParams.get("client_id")?.trim();

  if (!code) return { error: "The pasted address has no authorization code." };

  if (!clientId) return { error: "ChatGPT did not return a registered client ID. Start again." };

  return { code, clientId };
}

export const completeLogin = (input: typeof LoginCallback.Type) =>
  Effect.gen(function* () {
    const account = yield* Account;
    const protocol = yield* ChatGPTProtocol;

    return yield* account.locked(
      Effect.gen(function* (): Effect.fn.Return<LoginStatus, OperationError> {
        if (Option.isSome(yield* account.get(PROVIDER))) return { state: "connected" };
        const pending = yield* readPending(account.storage);

        if (Option.isNone(pending)) return { state: "not_connected" };

        if (pending.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
          yield* attempt("login.delete", () => account.storage.delete(LOGIN_KEY));

          return { state: "expired" };
        }

        const parsed = parseCallback(input.callbackUrl, pending.value.state);

        if ("error" in parsed) return { state: "error", error: parsed.error };

        const exchanged = yield* protocol
          .exchange({
            code: parsed.code,
            verifier: pending.value.verifier,
            clientId: parsed.clientId,
          })
          .pipe(
            Effect.flatMap((tokens) =>
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                toCredential(tokens, parsed.clientId, now),
              ),
            ),
            // Token endpoint messages carry only status codes and scopes, never token values.
            Effect.map((credential) => ({ credential }) as const),
            Effect.catchIf(
              (error) => error.operation === "chatgpt.token",
              (error) => Effect.succeed({ error: error.message } as const),
            ),
          );

        if ("error" in exchanged) {
          // An authorization code works once; the owner must start a fresh sign-in.
          yield* attempt("login.delete", () => account.storage.delete(LOGIN_KEY));

          return { state: "error", error: `${exchanged.error}. Start again.` };
        }

        // Do not interrupt between a rotating-token exchange and its local persistence.
        yield* account.put(PROVIDER, exchanged.credential);
        yield* attempt("login.delete", () => account.storage.delete(LOGIN_KEY));

        return { state: "connected" };
      }).pipe(Effect.uninterruptible),
    );
  });

/** The registration a stored credential carries alongside Pi's token fields. */
const StoredGrant = Schema.Struct({
  clientId: Schema.NonEmptyString,
  scopes: Schema.optional(Schema.Array(Schema.String)),
});

/** Pi's refresh hook. Pi already holds the credential store's lock while this runs. */
export const refreshCredential = (credential: OAuthCredential) =>
  Effect.gen(function* () {
    const protocol = yield* ChatGPTProtocol;
    const grant = Schema.decodeUnknownOption(StoredGrant)(credential);

    if (Option.isNone(grant))
      return yield* new OperationError({
        operation: "chatgpt.refresh",
        message: "This ChatGPT connection has no registered client. Sign in with ChatGPT again.",
        details: null,
      });
    const { clientId, scopes } = grant.value;
    const tokens = yield* protocol.refresh({ refresh: credential.refresh, clientId });

    return yield* toCredential(
      // A refresh response may omit scope; the grant keeps the scopes it was issued with.
      { ...tokens, scope: tokens.scope ?? (scopes ?? []).join(" ") },
      clientId,
      yield* Clock.currentTimeMillis,
    );
  });

export const logout = Effect.gen(function* () {
  const account = yield* Account;

  return yield* account.locked(
    Effect.gen(function* (): Effect.fn.Return<LoginStatus, OperationError> {
      yield* attempt("login.delete", () => account.storage.delete(LOGIN_KEY));
      yield* account.remove(PROVIDER);

      return { state: "not_connected" };
    }),
  );
});

/**
 * Pi's OpenAI Responses adapter, authenticated by the ChatGPT connection. Eager HTTP adapter:
 * never load Pi's Node-only loopback-server login in the Worker.
 */
export function chatgptProvider(
  onHeaders?: (headers: Record<string, string>) => void,
  wrapStream: (fn: ResponsesStream) => ResponsesStream = (fn) => fn,
) {
  const refresh = (credential: OAuthCredential) =>
    Effect.runPromise(
      refreshCredential(credential).pipe(
        Effect.provide(ChatGPTProtocol.layer),
        Effect.mapError(
          (error) =>
            new OperationError({
              operation: "chatgpt.refresh",
              message: redact(error.message, [credential.access, credential.refresh]),
              details: exceptionDetails(error, [credential.access, credential.refresh]),
            }),
        ),
      ),
    );

  return createProvider({
    id: PROVIDER,
    name: "ChatGPT",
    baseUrl: RESOURCE,
    models: [
      ...Object.values(OPENAI_MODELS).filter((model) => openaiIds.includes(model.id)),
      // Until Pi's catalog includes 6.2, inherit the previous generation's transport and
      // capabilities. Prefer Pi's own definitions as soon as they become available.
      ...(
        [
          ["gpt-6.2-astra", "gpt-6-astra", "GPT-6.2 Astra"],
          ["gpt-6.2-sol", "gpt-6.1-sol", "GPT-6.2 Sol"],
        ] as const
      ).flatMap(([id, predecessor, name]) =>
        Object.keys(OPENAI_MODELS).includes(id)
          ? []
          : [{ ...OPENAI_MODELS[predecessor], id, name }],
      ),
    ],
    api: onHeaders
      ? {
          stream: observeUsage(stream, onHeaders),
          streamSimple: wrapStream(observeUsage(streamSimple, onHeaders)),
        }
      : { stream, streamSimple: wrapStream(streamSimple) },
    auth: {
      oauth: {
        name: "OpenAI (ChatGPT subscription)",
        isSubscription: true,
        loginLabel: "Sign in with ChatGPT",
        // Sign-in runs through Dolly's settings, never Pi's loopback-server flow.
        login: () => Promise.reject(new Error("Sign in with ChatGPT from Dolly's settings")),
        toAuth: async (credential) => ({ apiKey: credential.access }),
        refresh,
      },
    },
  });
}
