import { verifyWithJwks } from "hono/jwt";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { attempt } from "./operations";
import { exceptionDetails } from "./diagnostics";
import type { Env } from "./env";

const AccessConfig = Schema.Struct({
  team: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/)),
  audience: Schema.String.check(Schema.isMinLength(1)),
});

const AccessClaims = Schema.Struct({
  exp: Schema.Finite,
  iss: Schema.String,
  aud: Schema.Array(Schema.String),
});

/** API_TOKEN alone never grants deployed access. Missing Access configuration fails closed. */
export const authorizeAccess = Effect.fn("Access.authorize")(function* (
  request: Request,
  env: Env,
) {
  if (env.ACCESS_LOCAL_DEV === "true") return "allowed";

  const configured = yield* Schema.decodeUnknownEffect(AccessConfig)({
    team: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
  }).pipe(Effect.option);

  if (Option.isNone(configured)) return "unconfigured";

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");

  if (!assertion) return "denied";

  const { team, audience } = configured.value;

  return yield* attempt("access.verify", (signal) =>
    verifyWithJwks(
      assertion,
      {
        jwks_uri: `https://${team}/cdn-cgi/access/certs`,
        allowedAlgorithms: ["RS256"],
        verification: { iss: `https://${team}`, aud: audience },
      },
      { signal, redirect: "error" },
    ),
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AccessClaims)),
    Effect.timeout("5 seconds"),
    Effect.tapError((cause) =>
      Effect.logWarning({
        event: "access_verification_failed",
        error: exceptionDetails(cause, [assertion]),
      }),
    ),
    Effect.match({ onSuccess: () => "allowed" as const, onFailure: () => "denied" as const }),
  );
});
