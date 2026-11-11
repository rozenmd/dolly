import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

class LoginError extends Schema.TaggedError()("LoginError", { message: Schema.String }) {}

const Status = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["connected", "not_connected", "expired"]) }),
  Schema.Struct({
    state: Schema.Literal("awaiting_code"),
    verificationUri: Schema.String,
    userCode: Schema.String,
    pollAfterSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);

const connect = Effect.gen(function* () {
  const base = yield* Config.string("API_URL").pipe(Config.withDefault("http://localhost:8787"));
  const token = yield* Config.redacted("API_TOKEN");

  if (Redacted.value(token).length < 32)
    return yield* new LoginError({ message: "Set API_TOKEN to at least 32 characters" });

  const url = yield* Effect.try({
    try: () => new URL("/api/auth/codex", base),
    catch: () => new LoginError({ message: "API_URL must be a valid URL" }),
  });

  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return yield* new LoginError({ message: "Use HTTPS except for local development" });
  }

  const clientId = yield* Config.redacted("CF_ACCESS_CLIENT_ID").pipe(Config.option);
  const clientSecret = yield* Config.redacted("CF_ACCESS_CLIENT_SECRET").pipe(Config.option);

  if (Option.isSome(clientId) !== Option.isSome(clientSecret))
    return yield* new LoginError({
      message: "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET",
    });

  const headers = new Headers({ Authorization: `Bearer ${Redacted.value(token)}` });

  if (Option.isSome(clientId) && Option.isSome(clientSecret)) {
    headers.set("CF-Access-Client-Id", Redacted.value(clientId.value));
    headers.set("CF-Access-Client-Secret", Redacted.value(clientSecret.value));
  }

  const request = Effect.fn("connect.request")(function* (method) {
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetch(url, {
                method,
                headers,
                redirect: "error",
                signal: AbortSignal.any([controller.signal, signal]),
              }),
            catch: () => new LoginError({ message: "Could not reach the Worker" }),
          });

          if (!response.ok)
            return yield* new LoginError({ message: `Worker returned HTTP ${response.status}` });
          const body = yield* Effect.tryPromise(() => response.json());

          return yield* Schema.decodeUnknownEffect(Status)(body);
        }),
      (controller) => Effect.sync(() => controller.abort()),
    );
  }, Effect.timeout("20 seconds"));

  let result = yield* request("POST");

  if (result.state === "awaiting_code")
    yield* Effect.logInfo(`Open ${result.verificationUri}\nEnter code: ${result.userCode}`);
  const deadline = (yield* Clock.currentTimeMillis) + 16 * 60_000;

  while (result.state === "awaiting_code" && (yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(Math.max(1, Math.min(900, result.pollAfterSeconds)) * 1000);
    result = yield* request("GET");
  }

  if (result.state !== "connected")
    return yield* new LoginError({
      message: `Login ended with state: ${result.state}. Run npm run login to start again.`,
    });
  yield* Effect.logInfo("Codex subscription connected. Credentials stay in the Worker.");
});

await Effect.runPromise(
  connect.pipe(
    Effect.catch((error) =>
      Effect.logError(error.message ?? String(error)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
);
