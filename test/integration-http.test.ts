import { afterEach, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { integrationJson } from "../src/integration-http";

afterEach(() => vi.restoreAllMocks());

it("aborts stalled provider requests after 15 seconds and forbids redirects", async () => {
  let aborted = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
        expect(init?.redirect).toBe("error");
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
        integrationJson("https://api.github.com/test", {}).pipe(Effect.flip),
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("16 seconds");
      expect((yield* Fiber.join(fiber)).message).toBe("Provider request timed out");
      expect(aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("cancels and releases a response whose body stalls", async () => {
  let cancelled = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const body = new ReadableStream<Uint8Array>({
        pull() {
          Effect.runSync(Deferred.succeed(started, undefined));
        },
        cancel() {
          cancelled = true;
        },
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));

      const fiber = yield* Effect.forkChild(
        integrationJson("https://api.github.com/test", {}).pipe(Effect.flip),
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("16 seconds");
      expect((yield* Fiber.join(fiber)).message).toBe("Provider request timed out");
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
