import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { exceptionDetails } from "./diagnostics";

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  operation: Schema.String,
  message: Schema.String,
  details: Schema.Unknown,
}) {}

/** Adapt Promise APIs once, keeping their diagnostics in the typed error channel. */
export const attempt = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const details = exceptionDetails(cause);

      return new OperationError({ operation, message: details.message, details });
    },
  });

/** RPC results are data-only, but Cloudflare still attaches a disposable response handle. */
export const rpc = <A>(operation: string, call: () => Promise<A>) =>
  Effect.acquireUseRelease(attempt(operation, call), Effect.succeed, (result) =>
    Effect.sync(() => {
      if (Predicate.hasProperty(result, Symbol.dispose)) {
        const dispose = result[Symbol.dispose];

        if (Predicate.isFunction(dispose)) dispose.call(result);
      }
    }),
  );
