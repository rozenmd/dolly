import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { exceptionDetails, redact } from "./diagnostics";
import { OperationError, attempt } from "./operations";

export const integrationJson = Effect.fn("Integration.request")(function* (
  url: string,
  init: RequestInit,
) {
  const authorization = new Headers(init.headers).get("Authorization") ?? "";
  const secrets = [authorization, authorization.replace(/^Bearer /, "")];

  return yield* Effect.gen(function* () {
    const response = yield* Effect.acquireRelease(
      attempt("integration.fetch", (signal) => fetch(url, { ...init, signal, redirect: "error" })),
      (value) =>
        attempt("integration.close", async () => {
          if (!value.body?.locked) await value.body?.cancel();
        }).pipe(Effect.catch(() => Effect.void)),
      { interruptible: true },
    );

    return yield* Effect.gen(function* () {
      if (!response.ok)
        return yield* new OperationError({
          operation: "integration.response",
          message: `Provider returned HTTP ${response.status}`,
          details: { status: response.status },
        });
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
            details: exceptionDetails(cause, secrets),
          })
        : new OperationError({
            operation: "integration.timeout",
            message: "Provider request timed out",
            details: null,
          }),
    ),
  );
});
