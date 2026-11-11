import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Account, Credentials } from "../src/credentials";
import { CodexProtocol, startLogin, pollLogin } from "../src/codex-login";
import { OperationError } from "../src/operations";
import { readBounded } from "../src/sandbox";

it("releases the credential permit when its holder is interrupted", async () => {
  await runInDurableObject(env.AGENT.getByName(crypto.randomUUID()), async (_, state) => {
    const account = new Credentials(state.storage);
    await Effect.runPromise(
      Effect.gen(function* () {
        const held = yield* Deferred.make<void>();

        const owner = yield* Effect.forkChild(
          account.locked(Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never))),
        );

        yield* Deferred.await(held);
        const next = yield* Effect.forkChild(account.locked(Effect.succeed("released")));
        yield* Fiber.interrupt(owner);
        expect(yield* Fiber.join(next)).toBe("released");
      }),
    );
  });
});

it("expires a device grant using Effect's TestClock without wall-clock waits", async () => {
  await runInDurableObject(env.AGENT.getByName(crypto.randomUUID()), async (_, state) => {
    const unexpected = new OperationError({
      operation: "test",
      message: "Unexpected network call",
      details: null,
    });

    const services = Layer.mergeAll(
      Layer.succeed(Account, new Credentials(state.storage)),
      Layer.succeed(CodexProtocol, {
        start: Effect.succeed({ device_auth_id: "device", user_code: "TEST-CODE", interval: 5 }),
        poll: () => Effect.fail(unexpected),
        exchange: () => Effect.fail(unexpected),
      }),
      TestClock.layer(),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* startLogin).toMatchObject({ state: "awaiting_code", expiresAt: 900_000 });
        yield* TestClock.adjust("15 minutes");
        expect(yield* pollLogin).toEqual({ state: "expired" });
      }).pipe(Effect.provide(services)),
    );
  });
});

it("drains shell output while retaining only the configured byte prefix", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(100_000)));
      controller.close();
    },
  });

  expect(
    await Effect.runPromise(readBounded(stream, { limit: 32_768, overflow: "truncate" })),
  ).toHaveLength(32_768);
  expect(stream.locked).toBe(false);
});

it("fails oversized file reads and cancels the reader", async () => {
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65_537));
    },
    cancel() {
      cancelled = true;
    },
  });

  const failure = await Effect.runPromise(
    Effect.flip(readBounded(stream, { limit: 65_536, overflow: "fail" })),
  );

  expect(failure.operation).toBe("sandbox.file.read");
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

it("cancels a pending reader when its Effect fiber is interrupted", async () => {
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        readBounded(stream, { limit: 32_768, overflow: "truncate" }),
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
    }),
  );
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

it("keeps a bounded Codex request deadline inside the token-rotation critical section", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.never.pipe(Effect.timeout("15 seconds"), Effect.uninterruptible, Effect.flip),
      );

      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(fiber))._tag).toBe("TimeoutError");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

it("times out an incomplete Codex response body and aborts its HTTP scope", async () => {
  let signal: AbortSignal | undefined;

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
    signal = init?.signal ?? undefined;

    return new Response(new ReadableStream<Uint8Array>());
  });

  try {
    const services = Layer.mergeAll(CodexProtocol.layer, TestClock.layer());
    await Effect.runPromise(
      Effect.gen(function* () {
        const protocol = yield* CodexProtocol;
        const fiber = yield* Effect.forkChild(Effect.flip(protocol.start));
        yield* TestClock.adjust("15 seconds");
        expect((yield* Fiber.join(fiber)).message).toBe("Codex request timed out");
        expect(signal?.aborted).toBe(true);
      }).pipe(Effect.provide(services)),
    );
  } finally {
    fetch.mockRestore();
  }
});
