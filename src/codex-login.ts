import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { exceptionDetails } from "./diagnostics";
import { Account } from "./credentials";
import { attempt, OperationError } from "./operations";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const PROVIDER = "openai-codex";

const DeviceResponse = Schema.Struct({
  device_auth_id: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  interval: Schema.Union([Schema.Finite, Schema.NumberFromString]).check(
    Schema.isBetween({ minimum: 0, maximum: 900 }),
  ),
});

const Device = Schema.Struct({
  ...DeviceResponse.fields,
  expiresAt: Schema.Finite,
  nextPollAt: Schema.Finite,
});

export type Device = typeof Device.Type;

const Authorization = Schema.Struct({
  authorization_code: Schema.NonEmptyString,
  code_verifier: Schema.NonEmptyString,
});

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
});

const OAuthFailure = Schema.Struct({
  error: Schema.Union([Schema.String, Schema.Struct({ code: Schema.String })]),
});

export type LoginStatus =
  | { readonly state: "connected" | "not_connected" | "expired" }
  | {
      readonly state: "awaiting_code";
      readonly verificationUri: string;
      readonly userCode: string;
      readonly expiresAt: number;
      readonly pollAfterSeconds: number;
    };

type DevicePoll =
  | { readonly kind: "pending" | "slow_down" }
  | { readonly kind: "authorized"; readonly authorization: typeof Authorization.Type };

export class CodexProtocol extends Context.Service<
  CodexProtocol,
  {
    start: Effect.Effect<typeof DeviceResponse.Type, OperationError>;
    poll(device: Device): Effect.Effect<DevicePoll, OperationError>;
    exchange(
      authorization: typeof Authorization.Type,
    ): Effect.Effect<typeof Tokens.Type, OperationError>;
  }
>()("pi-hard/CodexProtocol") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const http = HttpClient.withScope(yield* HttpClient.HttpClient);

      const bounded = <A>(effect: Effect.Effect<A, OperationError, Scope.Scope>) =>
        effect.pipe(
          Effect.scoped,
          Effect.timeout("15 seconds"),
          Effect.mapError((cause) =>
            cause instanceof OperationError
              ? cause
              : new OperationError({
                  operation: "codex.request",
                  message: "Codex request timed out",
                  details: exceptionDetails(cause),
                }),
          ),
        );

      const post = Effect.fn("CodexProtocol.post")(function* (
        path: string,
        body: string,
        contentType = "application/json",
      ) {
        return yield* http
          .execute(
            HttpClientRequest.post(`${AUTH}${path}`).pipe(
              HttpClientRequest.bodyText(body, contentType),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new OperationError({
                  operation: path,
                  message: "Codex request failed",
                  details: exceptionDetails(cause),
                }),
            ),
          );
      });

      const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, operation: string) =>
        flow(
          Schema.decodeUnknownEffect(schema),
          Effect.mapError(
            () =>
              new OperationError({
                operation,
                message: "Invalid Codex response",
                details: "Response values omitted because they can contain credentials",
              }),
          ),
        );

      const checked = Effect.fn("CodexProtocol.checked")(function* (
        path: string,
        body: string,
        contentType?: string,
      ) {
        const response = yield* post(path, body, contentType);

        if (response.status < 200 || response.status >= 300)
          return yield* new OperationError({
            operation: path,
            message: `Codex returned HTTP ${response.status}`,
            details: { status: response.status },
          });

        return yield* response.json.pipe(
          Effect.mapError(
            () =>
              new OperationError({
                operation: path,
                message: "Codex returned invalid JSON",
                details: { status: response.status },
              }),
          ),
        );
      }, bounded);

      return CodexProtocol.of({
        start: checked(
          "/api/accounts/deviceauth/usercode",
          JSON.stringify({ client_id: CLIENT_ID }),
        ).pipe(Effect.flatMap(decode(DeviceResponse, "device.start"))),
        poll: Effect.fn("CodexProtocol.poll")(function* (
          device,
        ): Effect.fn.Return<DevicePoll, OperationError, Scope.Scope> {
          const response = yield* post(
            "/api/accounts/deviceauth/token",
            JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
          );

          const body = yield* response.json.pipe(Effect.catch(() => Effect.succeed(null)));

          if (response.status >= 200 && response.status < 300)
            return {
              kind: "authorized",
              authorization: yield* decode(Authorization, "device.poll")(body),
            };
          const failure = Schema.decodeUnknownOption(OAuthFailure)(body);

          const code = Option.map(failure, ({ error }) =>
            Predicate.isString(error) ? error : error.code,
          );

          if (Option.getOrUndefined(code) === "slow_down") return { kind: "slow_down" };

          if (
            response.status === 403 ||
            response.status === 404 ||
            Option.getOrUndefined(code) === "deviceauth_authorization_pending"
          )
            return { kind: "pending" };

          return yield* new OperationError({
            operation: "device.poll",
            message: `Codex returned HTTP ${response.status}`,
            details: { status: response.status },
          });
        }, bounded),
        exchange: Effect.fn("CodexProtocol.exchange")((authorization) =>
          checked(
            "/oauth/token",
            new URLSearchParams({
              grant_type: "authorization_code",
              client_id: CLIENT_ID,
              code: authorization.authorization_code,
              code_verifier: authorization.code_verifier,
              redirect_uri: `${AUTH}/deviceauth/callback`,
            }).toString(),
            "application/x-www-form-urlencoded",
          ).pipe(Effect.flatMap(decode(Tokens, "token.exchange"))),
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

function awaiting(device: Device, now: number): LoginStatus {
  return {
    state: "awaiting_code",
    verificationUri: `${AUTH}/codex/device`,
    userCode: device.user_code,
    expiresAt: device.expiresAt,
    pollAfterSeconds: Math.max(1, Math.ceil((device.nextPollAt - now) / 1000)),
  };
}

const readDevice = Effect.fn("Account.readDevice")(function* (storage: DurableObjectStorage) {
  const raw = yield* attempt("login.read", () => storage.get("login"));

  if (raw === undefined) return Option.none<Device>();

  return yield* Schema.decodeUnknownEffect(Device)(raw).pipe(
    Effect.map(Option.some),
    Effect.mapError(
      () =>
        new OperationError({
          operation: "login.read",
          message: "Invalid stored device grant",
          details: "Start a new login",
        }),
    ),
  );
});

export const startLogin = Effect.gen(function* () {
  const account = yield* Account;
  const protocol = yield* CodexProtocol;

  return yield* account.locked(
    Effect.gen(function* (): Effect.fn.Return<LoginStatus, OperationError> {
      if (Option.isSome(yield* account.get(PROVIDER))) return { state: "connected" };
      const now = yield* Clock.currentTimeMillis;
      const existing = yield* readDevice(account.storage);

      if (Option.isSome(existing) && existing.value.expiresAt > now)
        return awaiting(existing.value, now);
      const parsed = yield* protocol.start;
      const startedAt = yield* Clock.currentTimeMillis;

      const device = {
        ...parsed,
        expiresAt: startedAt + 900_000,
        nextPollAt: startedAt + Math.max(1, parsed.interval) * 1000,
      };

      yield* attempt("login.write", () => account.storage.put("login", device));

      return awaiting(device, startedAt);
    }),
  );
});

export const pollLogin = Effect.gen(function* () {
  const account = yield* Account;
  const protocol = yield* CodexProtocol;

  return yield* account.locked(
    Effect.gen(function* (): Effect.fn.Return<LoginStatus, OperationError> {
      if (Option.isSome(yield* account.get(PROVIDER))) return { state: "connected" };
      const stored = yield* readDevice(account.storage);

      if (Option.isNone(stored)) return { state: "not_connected" };
      const device = stored.value;
      const now = yield* Clock.currentTimeMillis;

      if (device.expiresAt <= now) {
        yield* attempt("login.delete", () => account.storage.delete("login"));

        return { state: "expired" };
      }

      if (now < device.nextPollAt) return awaiting(device, now);
      const next = { ...device, nextPollAt: now + Math.max(1, device.interval) * 1000 };
      yield* attempt("login.write", () => account.storage.put("login", next));
      const result = yield* protocol.poll(device);

      if (result.kind === "authorized") {
        const tokens = yield* protocol.exchange(result.authorization);
        const connectedAt = yield* Clock.currentTimeMillis;
        // Do not interrupt between a rotating-token exchange and its local persistence.
        yield* account.put(PROVIDER, {
          type: "oauth",
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: connectedAt + tokens.expires_in * 1000,
        });
        yield* attempt("login.delete", () => account.storage.delete("login"));

        return { state: "connected" };
      }

      if (result.kind === "slow_down") {
        const after = yield* Clock.currentTimeMillis;

        const slowed = {
          ...device,
          interval: device.interval + 5,
          nextPollAt: after + (device.interval + 5) * 1000,
        };

        yield* attempt("login.write", () => account.storage.put("login", slowed));

        return awaiting(slowed, after);
      }

      return awaiting(next, yield* Clock.currentTimeMillis);
    }).pipe(Effect.uninterruptible),
  );
});

export const logout = Effect.gen(function* () {
  const account = yield* Account;

  return yield* account.locked(
    Effect.gen(function* (): Effect.fn.Return<LoginStatus, OperationError> {
      yield* attempt("login.delete", () => account.storage.delete("login"));
      yield* account.remove(PROVIDER);

      return { state: "not_connected" };
    }),
  );
});
