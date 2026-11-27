/**
 * Output handling for the shell tool's commands: the tail of each stream the
 * model gets back, and the live output relayed to the Agent while a command
 * runs. Commands may run for many minutes, so neither may grow without bound.
 */

import * as Predicate from "effect/Predicate";
import { OperationError } from "./operations";

/** Seconds a shell tool command may run when the model does not say. */
export const SHELL_TIMEOUT_DEFAULT_SECONDS = 600;

/** The longest `timeout` the shell tool accepts, in seconds. */
export const SHELL_TIMEOUT_MAX_SECONDS = 3600;

/** Bytes of each of stdout and stderr returned to the model: the end, where errors and summaries are. */
export const SHELL_OUTPUT_LIMIT = 32_768;

/** Exit code reported for a command stopped at its timeout, as coreutils `timeout` does. */
export const SHELL_TIMEOUT_EXIT_CODE = 124;

/** The last `limit` bytes of a stream, and how many bytes came before them. */
export class OutputTail {
  private chunks: Uint8Array[] = [];
  private retained = 0;
  private total = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Uint8Array) {
    const kept = chunk.length > this.limit ? chunk.slice(chunk.length - this.limit) : chunk;
    this.total += chunk.length;
    this.chunks.push(kept);
    this.retained += kept.length;

    while (this.chunks.length > 1 && this.retained - this.chunks[0]!.length >= this.limit)
      this.retained -= this.chunks.shift()!.length;
  }

  text() {
    const bytes = new Uint8Array(this.retained);
    let offset = 0;

    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    const tail = bytes.subarray(Math.max(0, bytes.length - this.limit));
    const omitted = this.total - tail.length;
    const text = new TextDecoder().decode(tail);

    // A cut can land inside a UTF-8 character; drop its undecodable remains.
    return omitted
      ? `[${omitted} earlier bytes omitted]\n${text.replace(/^\uFFFD{1,3}/, "")}`
      : text;
  }
}

type RelayOptions = {
  /** Longest wait before buffered output is sent, in milliseconds. */
  readonly interval: number;
  /** Buffered characters that trigger a send at once. */
  readonly batch: number;
  /** Characters buffered or in flight beyond which new output is dropped (and counted). */
  readonly backlog: number;
  /** Longest wait for the last sends when the command ends, in milliseconds. */
  readonly drain: number;
};

const RELAY_DEFAULTS: RelayOptions = {
  interval: 250,
  batch: 16_384,
  backlog: 262_144,
  drain: 5_000,
};

/**
 * Sends live output to the caller in order, in batches, so a chatty command
 * costs a few RPCs a second rather than one per chunk. A slow caller cannot
 * make memory grow (output past the backlog is dropped and counted), and a
 * failed send (the caller went away) stops relaying without failing the command.
 */
export class OutputRelay {
  private buffer = "";
  private skipped = 0;
  private inFlight = 0;
  private failed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly options: RelayOptions;

  constructor(
    private readonly send: (text: string) => void | Promise<void>,
    options: Partial<RelayOptions> = {},
  ) {
    this.options = { ...RELAY_DEFAULTS, ...options };
  }

  push(text: string) {
    if (this.failed || !text) return;

    if (this.inFlight + this.buffer.length + text.length > this.options.backlog) {
      this.skipped += text.length;

      return;
    }

    this.noteSkipped();
    this.buffer += text;

    if (this.buffer.length >= this.options.batch) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.options.interval);
  }

  /** Send what is buffered and wait (bounded) for every send to finish. */
  async close() {
    this.noteSkipped();
    this.flush();

    let timer: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
      this.chain,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.drain);
      }),
    ]);
    clearTimeout(timer);
  }

  private noteSkipped() {
    if (!this.skipped) return;

    this.buffer += `\n[${this.skipped} characters of live output skipped]\n`;
    this.skipped = 0;
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;

    if (!this.buffer) return;

    const text = this.buffer;
    this.buffer = "";
    this.inFlight += text.length;

    this.chain = this.chain.then(async () => {
      try {
        if (!this.failed) await this.send(text);
      } catch {
        this.failed = true;
      } finally {
        this.inFlight -= text.length;
      }
    });
  }
}

/** A `Sandbox.runUntilCancelled` command stopped through `Sandbox.cancel`. */
export type RunCancelled = { readonly cancelled: true };

export const RUN_CANCELLED_MESSAGE = "The command was cancelled";

export const RUN_CANCELLED: RunCancelled = { cancelled: true };

export const isRunCancelled = <A>(outcome: A | RunCancelled): outcome is RunCancelled =>
  Predicate.hasProperty(outcome, "cancelled") && outcome.cancelled === true;

/**
 * Run a sandbox command that `signal` can stop. A Durable Object RPC in flight cannot be cancelled,
 * so aborting asks the Sandbox to stop the run by its execution ID. The Sandbox reports the stop as
 * a value (a rejected RPC is logged by workerd as an uncaught exception); this rejects with it.
 */
export async function runCancellable<A extends object>(
  sandbox: { cancel(executionId: string): boolean | Promise<boolean> },
  signal: AbortSignal | undefined,
  run: (executionId: string) => Promise<A>,
): Promise<Exclude<A, RunCancelled>> {
  signal?.throwIfAborted();

  const executionId = crypto.randomUUID();

  const cancel = () => {
    Promise.resolve(sandbox.cancel(executionId)).catch(() => {});
  };

  signal?.addEventListener("abort", cancel, { once: true });

  try {
    const outcome = await run(executionId);

    if (isRunCancelled(outcome))
      throw new OperationError({
        operation: "sandbox.run",
        message: RUN_CANCELLED_MESSAGE,
        details: null,
      });

    // SAFETY: isRunCancelled above rejected the one RunCancelled shape A can include.
    return outcome as Exclude<A, RunCancelled>;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Bytes of the serialized shell result, safely below the 50 KiB Pi keeps of a tool result: past
 * that Pi cuts the text, which would split the JSON and lose `exitCode` and `timedOut`.
 */
export const SHELL_RESULT_MAX_BYTES = 48 * 1024;

const OMITTED = /^\[(\d+) earlier bytes omitted\]\n/;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Bytes a string takes inside serialized JSON, without its quotes. */
const escapedLength = (text: string) => byteLength(JSON.stringify(text)) - 2;

/** Drop at least `bytes` bytes from the start of a stream's text, keeping an accurate omission note. */
function dropStart(text: string, bytes: number) {
  const marker = OMITTED.exec(text);
  const earlier = marker ? Number(marker[1]) : 0;
  const body = new TextEncoder().encode(marker ? text.slice(marker[0].length) : text);
  const cut = Math.min(body.length, bytes);
  const rest = new TextDecoder().decode(body.subarray(cut)).replace(/^\uFFFD{1,3}/, "");

  return `[${earlier + cut} earlier bytes omitted]\n${rest}`;
}

/** Trim the start of `text` until it takes at most `budget` bytes inside JSON. */
function fitStream(text: string, budget: number) {
  let fitted = text;

  for (let size = escapedLength(fitted); size > budget; size = escapedLength(fitted)) {
    // Escaping can make a byte take up to six; cut in proportion so each step frees enough.
    const raw = byteLength(fitted);
    fitted = dropStart(fitted, Math.ceil(((size - budget) * raw) / size) + 8);

    if (byteLength(fitted) >= raw) break;
  }

  return fitted;
}

/**
 * Serialize a shell result within {@link SHELL_RESULT_MAX_BYTES}, trimming the start of stdout and
 * stderr as needed. Each stream may use half the room; one that needs less leaves the rest to the
 * other. Sizes are measured as serialized, since JSON escaping can make text grow up to six times.
 */
export function serializeShellResult<
  R extends { readonly stdout: string; readonly stderr: string },
>(result: R, maxBytes = SHELL_RESULT_MAX_BYTES) {
  const whole = JSON.stringify(result);

  if (byteLength(whole) <= maxBytes) return whole;

  const room = Math.max(
    0,
    maxBytes - byteLength(JSON.stringify({ ...result, stdout: "", stderr: "" })),
  );

  const stdout = escapedLength(result.stdout);
  const stderr = escapedLength(result.stderr);
  const half = Math.floor(room / 2);
  const stdoutBudget = stdout <= half ? stdout : stderr <= half ? room - stderr : half;

  return JSON.stringify({
    ...result,
    stdout: fitStream(result.stdout, stdoutBudget),
    stderr: fitStream(result.stderr, room - stdoutBudget),
  });
}
