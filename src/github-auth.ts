import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { attempt, OperationError } from "./operations";

/** How long a browser stays signed in before GitHub sign-in is needed again. */
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export const DEVICE_FLOW_DISABLED =
  'Device flow is turned off for this GitHub App, so nobody can sign in. Tick "Enable Device Flow" in the app\'s settings on GitHub, then try again.';

const DeviceCode = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.String,
  expires_in: Schema.Finite,
  interval: Schema.Finite,
});

const ProviderError = Schema.Struct({ error: Schema.String });

const AccessToken = Schema.Struct({ access_token: Schema.NonEmptyString });

const GitHubUser = Schema.Struct({ id: Schema.Finite, login: Schema.String });

const Owner = Schema.Struct({ id: Schema.Finite, login: Schema.String });

const Session = Schema.Struct({ ownerId: Schema.Finite, expires: Schema.Finite });

const Device = Schema.Struct({
  deviceCode: Schema.String,
  userCode: Schema.String,
  verificationUri: Schema.String,
  expiresAt: Schema.Finite,
  interval: Schema.Finite,
  nextPollAt: Schema.Finite,
});

type Device = typeof Device.Type;

export type SignInStatus =
  | {
      readonly state: "awaiting_code";
      readonly verificationUri: string;
      readonly userCode: string;
      readonly expiresAt: number;
      readonly pollAfterSeconds: number;
    }
  | { readonly state: "expired" }
  | { readonly state: "denied"; readonly message: string }
  | { readonly state: "signed_in"; readonly login: string; readonly session: string };

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Session and device-flow handles are stored only as hashes, so storage never holds a usable cookie. */
const hash = Effect.fn("GitHubAuth.hash")(function* (value: string) {
  const digest = yield* attempt("auth.hash", () =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );

  return base64url(new Uint8Array(digest));
});

const post = Effect.fn("GitHubAuth.post")(
  function* (url: string, body: Record<string, string>) {
    const response = yield* attempt("auth.github", (signal) =>
      fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "pi-hard",
        },
        body: new URLSearchParams(body).toString(),
        redirect: "error",
        signal,
      }),
    );

    const json = yield* attempt("auth.github.json", () => response.json()).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

    return { status: response.status, json };
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError((cause) =>
        cause instanceof OperationError
          ? cause
          : new OperationError({
              operation: "auth.github",
              message: "GitHub timed out",
              details: null,
            }),
      ),
    ),
);

function awaiting(device: Device, now: number): SignInStatus {
  return {
    state: "awaiting_code",
    verificationUri: device.verificationUri,
    userCode: device.userCode,
    expiresAt: device.expiresAt,
    pollAfterSeconds: Math.max(1, Math.ceil((device.nextPollAt - now) / 1000)),
  };
}

function invalid(operation: string) {
  return new OperationError({ operation, message: "Invalid GitHub response", details: null });
}

/**
 * GitHub device sign-in for the web UI. The first GitHub account to sign in after the
 * GitHub App is created becomes the owner; every later sign-in must be that account.
 */
function makeGitHubAuth(storage: DurableObjectStorage) {
  const permit = Semaphore.makeUnsafe(1);

  const owner = Effect.gen(function* () {
    const raw = yield* attempt("auth.owner.read", () => storage.get("auth:owner"));

    return raw === undefined
      ? Option.none<typeof Owner.Type>()
      : Option.some(
          yield* Schema.decodeUnknownEffect(Owner)(raw).pipe(
            Effect.mapError(() => invalid("auth.owner")),
          ),
        );
  });

  const start = Effect.fn("GitHubAuth.start")(function* (clientId: string) {
    const reply = yield* post("https://github.com/login/device/code", {
      client_id: clientId,
    });

    const failure = Schema.decodeUnknownOption(ProviderError)(reply.json);

    if (Option.isSome(failure) && failure.value.error === "device_flow_disabled")
      return { error: DEVICE_FLOW_DISABLED };

    const code = yield* Schema.decodeUnknownEffect(DeviceCode)(reply.json).pipe(
      Effect.mapError(
        () =>
          new OperationError({
            operation: "auth.device.start",
            message: `GitHub device sign-in failed (HTTP ${reply.status})`,
            details: { status: reply.status, error: Option.getOrUndefined(failure)?.error },
          }),
      ),
    );

    const now = yield* Clock.currentTimeMillis;
    const flow = base64url(crypto.getRandomValues(new Uint8Array(32)));

    const device: Device = {
      deviceCode: code.device_code,
      userCode: code.user_code,
      verificationUri: code.verification_uri,
      expiresAt: now + code.expires_in * 1000,
      interval: Math.max(1, code.interval),
      nextPollAt: now + Math.max(1, code.interval) * 1000,
    };

    const key = `auth:device:${yield* hash(flow)}`;

    yield* attempt("auth.device.save", () => storage.put(key, device));

    return { flow, status: awaiting(device, now) };
  });

  const createSession = Effect.fn("GitHubAuth.session.create")(function* (ownerId: number) {
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const now = yield* Clock.currentTimeMillis;
    const key = `auth:session:${yield* hash(token)}`;

    yield* attempt("auth.session.save", () =>
      storage.put(key, { ownerId, expires: now + SESSION_MS }),
    );

    return token;
  });

  const poll = Effect.fn("GitHubAuth.poll")(function* (clientId: string, flow: string) {
    return yield* permit.withPermit(
      Effect.gen(function* (): Effect.fn.Return<SignInStatus, OperationError> {
        const key = `auth:device:${yield* hash(flow)}`;
        const raw = yield* attempt("auth.device.read", () => storage.get(key));

        if (raw === undefined) return { state: "expired" };

        const device = yield* Schema.decodeUnknownEffect(Device)(raw).pipe(
          Effect.mapError(() => invalid("auth.device")),
        );

        const now = yield* Clock.currentTimeMillis;

        if (device.expiresAt <= now) {
          yield* attempt("auth.device.delete", () => storage.delete(key));

          return { state: "expired" };
        }

        if (now < device.nextPollAt) return awaiting(device, now);

        const next = { ...device, nextPollAt: now + device.interval * 1000 };
        yield* attempt("auth.device.write", () => storage.put(key, next));

        const reply = yield* post("https://github.com/login/oauth/access_token", {
          client_id: clientId,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });

        const token = Schema.decodeUnknownOption(AccessToken)(reply.json);

        if (Option.isNone(token)) {
          const error = Option.getOrUndefined(
            Schema.decodeUnknownOption(ProviderError)(reply.json),
          )?.error;

          if (error === "authorization_pending") return awaiting(next, now);

          if (error === "slow_down") {
            const slowed = {
              ...device,
              interval: device.interval + 5,
              nextPollAt: now + (device.interval + 5) * 1000,
            };

            yield* attempt("auth.device.write", () => storage.put(key, slowed));

            return awaiting(slowed, now);
          }

          yield* attempt("auth.device.delete", () => storage.delete(key));

          if (error === "expired_token") return { state: "expired" };

          if (error === "access_denied")
            return { state: "denied", message: "The sign-in was cancelled on GitHub." };

          return yield* new OperationError({
            operation: "auth.device.poll",
            message: `GitHub device sign-in failed (HTTP ${reply.status})`,
            details: { status: reply.status, error },
          });
        }

        yield* attempt("auth.device.delete", () => storage.delete(key));

        const response = yield* attempt("auth.user", (signal) =>
          fetch("https://api.github.com/user", {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token.value.access_token}`,
              "User-Agent": "pi-hard",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            redirect: "error",
            signal,
          }),
        );

        if (!response.ok)
          return yield* new OperationError({
            operation: "auth.user",
            message: `GitHub returned HTTP ${response.status} for the signed-in user`,
            details: { status: response.status },
          });

        const user = yield* attempt("auth.user.json", () => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(GitHubUser)),
          Effect.mapError(() => invalid("auth.user")),
        );

        const current = yield* owner;

        if (Option.isNone(current))
          yield* attempt("auth.owner.save", () =>
            storage.put("auth:owner", { id: user.id, login: user.login }),
          );
        else if (current.value.id !== user.id)
          return {
            state: "denied",
            message: `You signed in as @${user.login}, but this pi-hard belongs to @${current.value.login}.`,
          };

        return { state: "signed_in", login: user.login, session: yield* createSession(user.id) };
      }),
    );
  });

  /** The owner's login when the session is valid and still belongs to the owner. */
  const session = Effect.fn("GitHubAuth.session")(function* (token: string) {
    if (!token) return null;

    const key = `auth:session:${yield* hash(token)}`;
    const raw = yield* attempt("auth.session.read", () => storage.get(key));

    if (raw === undefined) return null;

    const value = Schema.decodeUnknownOption(Session)(raw);
    const current = yield* owner;
    const now = yield* Clock.currentTimeMillis;

    if (
      Option.isNone(value) ||
      Option.isNone(current) ||
      value.value.ownerId !== current.value.id ||
      value.value.expires <= now
    ) {
      yield* attempt("auth.session.delete", () => storage.delete(key));

      return null;
    }

    return { login: current.value.login };
  });

  const signOut = Effect.fn("GitHubAuth.signOut")(function* (token: string) {
    if (token) {
      const key = `auth:session:${yield* hash(token)}`;

      yield* attempt("auth.session.delete", () => storage.delete(key));
    }

    return { signedIn: false };
  });

  return { owner, start, poll, session, signOut };
}

export class GitHubAuth extends Context.Service<GitHubAuth, ReturnType<typeof makeGitHubAuth>>()(
  "pi-hard/GitHubAuth",
) {
  static readonly layer = (storage: DurableObjectStorage) =>
    Layer.succeed(GitHubAuth, makeGitHubAuth(storage));
}
