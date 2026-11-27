import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { exceptionDetails, redact } from "./diagnostics";
import { OperationError, attempt } from "./operations";
import { Buffer } from "node:buffer";

const ProviderError = Schema.Struct({
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          message: Schema.optional(Schema.String),
          field: Schema.optional(Schema.String),
          code: Schema.optional(Schema.String),
        }),
      ]),
    ),
  ),
});

/** The provider's own explanation, e.g. GitHub's 422 validation errors, read from at most 4 KiB. */
const errorReason = (response: Response) =>
  attempt("integration.error", async () => {
    const reader = response.body?.getReader();

    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      while (size < 4096) {
        const next = await reader.read();

        if (next.done) break;
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, 4096));
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ProviderError))(text);

    if (Option.isNone(parsed)) return "";

    const details = (parsed.value.errors ?? []).map((item) =>
      Schema.is(Schema.String)(item)
        ? item
        : (item.message ?? [item.field, item.code].filter(Boolean).join(" ")),
    );

    return [parsed.value.message ?? parsed.value.error, ...details]
      .filter(Boolean)
      .join("; ")
      .slice(0, 500);
  }).pipe(Effect.catch(() => Effect.succeed("")));

const GITHUB_API = "https://api.github.com";

/** GitHub answers a renamed or transferred repository's old path with one of these. */
const REDIRECTS = new Set([301, 302, 307, 308]);

const MAX_REDIRECTS = 3;

/**
 * Fetch without following redirects, except within GitHub's API: a renamed or transferred
 * repository redirects to its new path on api.github.com, and following that keeps the request's
 * credentials on the host they were issued for. Any other redirect is returned as is, and fails.
 */
async function fetchFollowingGitHub(url: string, init: RequestInit, signal: AbortSignal) {
  let target = url;

  for (let hop = 0; ; hop++) {
    const response = await fetch(target, { ...init, signal, redirect: "manual" });
    const location = response.headers.get("Location");

    if (
      !REDIRECTS.has(response.status) ||
      !location ||
      hop >= MAX_REDIRECTS ||
      !URL.canParse(target) ||
      new URL(target).origin !== GITHUB_API ||
      !URL.canParse(location, target)
    )
      return response;
    const next = new URL(location, target);

    if (next.origin !== GITHUB_API) return response;
    await response.body?.cancel().catch(() => {});
    target = next.href;
  }
}

export const integrationJson = Effect.fn("Integration.request")(function* (
  url: string,
  init: RequestInit,
) {
  const authorization = new Headers(init.headers).get("Authorization") ?? "";
  const secrets = [authorization, authorization.replace(/^Bearer /, "")];

  return yield* Effect.gen(function* () {
    const response = yield* Effect.acquireRelease(
      attempt("integration.fetch", (signal) => fetchFollowingGitHub(url, init, signal)),
      (value) =>
        attempt("integration.close", async () => {
          if (!value.body?.locked) await value.body?.cancel();
        }).pipe(Effect.catch(() => Effect.void)),
      { interruptible: true },
    );

    return yield* Effect.gen(function* () {
      if (!response.ok) {
        const reason = yield* errorReason(response);

        return yield* new OperationError({
          operation: "integration.response",
          message: `Provider returned HTTP ${response.status}${reason ? `: ${reason}` : ""}`,
          details: { status: response.status },
        });
      }

      const reader = response.body?.getReader();

      if (!reader)
        return yield* new OperationError({
          operation: "integration.body",
          message: "Provider returned an empty response",
          details: null,
        });

      return yield* Effect.acquireUseRelease(
        Effect.succeed(reader),
        (body) =>
          Effect.gen(function* () {
            const buffer = new Uint8Array(1_048_576);
            let size = 0;

            while (true) {
              const next = yield* attempt("integration.read", () => body.read());

              if (next.done) break;

              if (size + next.value.byteLength > buffer.byteLength)
                return yield* new OperationError({
                  operation: "integration.body",
                  message: "Provider response exceeds 1 MiB",
                  details: { limit: buffer.byteLength },
                });
              buffer.set(next.value, size);
              size += next.value.byteLength;
            }

            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
              new TextDecoder().decode(buffer.subarray(0, size)),
            ).pipe(
              Effect.mapError(
                () =>
                  new OperationError({
                    operation: "integration.json",
                    message: "Provider returned invalid JSON",
                    details: null,
                  }),
              ),
            );
          }),
        (body) =>
          attempt("integration.cancel", () => body.cancel()).pipe(
            Effect.ensuring(Effect.sync(() => body.releaseLock())),
            Effect.catch(() => Effect.void),
          ),
      );
    });
  }).pipe(
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      cause instanceof OperationError
        ? new OperationError({
            operation: cause.operation,
            message: redact(cause.message, secrets),
            details: {
              ...exceptionDetails(cause, secrets),
              status: Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }))(
                cause.details,
              ).pipe(
                Option.map((value) => value.status),
                Option.getOrUndefined,
              ),
            },
          })
        : new OperationError({
            operation: "integration.timeout",
            message: "Provider request timed out",
            details: null,
          }),
    ),
  );
});
