import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Account, Credentials } from "../src/credentials";
import { CodexProtocol, startLogin, pollLogin } from "../src/codex-login";
import { OperationError } from "../src/operations";
import { readBounded, readWindow } from "../src/sandbox";

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
    await Effect.runPromise(readBounded(stream, { limit: 32_768 })),
  ).toHaveLength(32_768);
  expect(stream.locked).toBe(false);
});

const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}\n`).join("");

const chunked = (text: string, onCancel = () => {}) => {
  const bytes = new TextEncoder().encode(text);
  let position = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position >= bytes.length) return controller.close();
      // Split mid-line and mid-character to exercise incremental decoding.
      controller.enqueue(bytes.subarray(position, position + 4093));
      position += 4093;
    },
    cancel: onCancel,
  });
};

it("windows large file reads by line, stops reading early and says how to continue", async () => {
  let cancelled = false;
  const stream = chunked(lines(1, 100_000), () => {
    cancelled = true;
  });

  const first = await Effect.runPromise(readWindow(stream, {}));

  expect(first).toBe(`${lines(1, 2000)}\n[Showing lines 1-2000. Use offset=2001 to continue.]`);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);

  expect(await Effect.runPromise(readWindow(chunked(lines(1, 100_000)), { offset: 99_999 }))).toBe(
    lines(99_999, 100_000),
  );
  expect(
    await Effect.runPromise(readWindow(chunked(lines(1, 10)), { offset: 3, limit: 2 })),
  ).toBe(`${lines(3, 4)}\n[Showing lines 3-4. Use offset=5 to continue.]`);
  expect(await Effect.runPromise(readWindow(chunked(lines(1, 10)), { offset: 20 }))).toBe(
    "\n[offset 20 is past the end of the file (10 lines).]",
  );
  expect(await Effect.runPromise(readWindow(chunked("é".repeat(10_000)), {}))).toBe(
    "é".repeat(10_000),
  );
});

it("caps reads by bytes and cuts a single oversized line", async () => {
  const wide = `${"x".repeat(1000)}\n`.repeat(200);
  const window = await Effect.runPromise(readWindow(chunked(wide), {}));

  expect(window).toBe(
    `${`${"x".repeat(1000)}\n`.repeat(51)}\n[Showing lines 1-51. Use offset=52 to continue.]`,
  );

  const minified = await Effect.runPromise(
    readWindow(chunked(`short\n${"y".repeat(500_000)}\nnext\n`), { offset: 2 }),
  );

  expect(minified).toBe(
    `${"y".repeat(51_200)}\n\n[Line 2 exceeds 50 KiB and was cut; use a shell command such as cut or head -c to read the rest.]\n[Showing lines 2-2. Use offset=3 to continue.]`,
  );
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
        readBounded(stream, { limit: 32_768 }),
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
