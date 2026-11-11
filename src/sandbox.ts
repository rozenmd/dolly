import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import * as Effect from "effect/Effect";
import { attempt, OperationError } from "./operations";
import { exceptionDetails } from "./diagnostics";
import type { Env } from "./env";

/** Drain output without retaining unbounded bytes. Scoped cancellation releases the native reader. */
export const readBounded = Effect.fn("Sandbox.readBounded")(function*(
  stream: ReadableStream<Uint8Array> | null,
  options: { readonly limit: number; readonly overflow: "truncate" | "fail" },
) {
  if (!stream) return "";
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    (reader) => Effect.gen(function*() {
      const bytes = new Uint8Array(options.limit);
      let retained = 0;
      while (true) {
        const chunk = yield* attempt("sandbox.stream.read", () => reader.read());
        if (chunk.done) return new TextDecoder().decode(bytes.subarray(0, retained));
        if (options.overflow === "fail" && retained + chunk.value.byteLength > options.limit) {
          return yield* new OperationError({ operation: "sandbox.file.read", message: "File exceeds 64 KiB; use a shell command to read a range", details: { limit: options.limit } });
        }
        const prefix = chunk.value.subarray(0, bytes.length - retained);
        bytes.set(prefix, retained);
        retained += prefix.length;
      }
    }),
    (reader) => attempt("sandbox.stream.cancel", () => reader.cancel()).pipe(
      Effect.catch((cause) => Effect.logWarning({ event: "stream_cleanup_failed", error: exceptionDetails(cause) })),
      Effect.ensuring(Effect.sync(() => reader.releaseLock())),
    ),
  );
});

export class Sandbox extends DurableObject<Env> {
  private container = Effect.fn("Sandbox.container")(function*(this: Sandbox) {
    const container = this.ctx.container;
    if (!container) return yield* Effect.die("Sandbox Container binding is not configured");
    if (!container.running) container.start({ image: container.images.sandbox, enableInternet: false });
    yield* attempt("sandbox.inactivity", () => container.setInactivityTimeout(300_000));
    return container;
  });

  run(command: string) {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const container = yield* this.container();
      let exited = false;
      return yield* Effect.acquireUseRelease(
        attempt("sandbox.exec", (signal) => container.exec(["sh", "-lc", command], { cwd: "/workspace", signal })),
        (process) => Effect.all({
          stdout: readBounded(process.stdout, { limit: 32_768, overflow: "truncate" }),
          stderr: readBounded(process.stderr, { limit: 32_768, overflow: "truncate" }),
          exitCode: attempt("sandbox.exit", () => process.exitCode).pipe(Effect.tap(() => Effect.sync(() => { exited = true; }))),
        }, { concurrency: "unbounded" }),
        (process) => exited ? Effect.void : Effect.try(() => process.kill()).pipe(
          Effect.catch((cause) => Effect.logWarning({ event: "process_cleanup_failed", error: exceptionDetails(cause) })),
        ),
      );
    }).pipe(Effect.timeout("60 seconds")));
  }

  readFile(path: string) {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const container = yield* this.container();
      const response = yield* attempt("sandbox.file.open", (signal) => new Files(container).readFile(path, { signal }));
      return yield* readBounded(response.body, { limit: 65_536, overflow: "fail" });
    }).pipe(Effect.timeout("60 seconds")));
  }
}
