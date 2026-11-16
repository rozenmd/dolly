import { DurableObject } from "cloudflare:workers";
import { zstdDecompressSync } from "node:zlib";
import type { StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
import type { Env } from "./env";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { exceptionDetails, redact } from "./diagnostics";

async function logCodexExit(
  process: ExecProcess,
  requestId: string,
  token: string,
  startedAt: number,
) {
  const reader = process.stderr?.getReader();
  const decoder = new TextDecoder();
  let stderr = "";

  try {
    if (reader)
      while (true) {
        const next = await reader.read();

        if (next.done) break;

        stderr = (stderr + decoder.decode(next.value, { stream: true })).slice(-65536);
      }

    const exitCode = await process.exitCode;

    const details = {
      event: "codex_cli_exit",
      requestId,
      exitCode,
      elapsedMs: Date.now() - startedAt,
      diagnostic: redact(stderr, [token]).slice(-16384),
    };

    if (exitCode === 0 && !stderr) console.info(details);
    else console.error(details);
  } catch (cause) {
    console.error({
      event: "codex_diagnostics_failed",
      requestId,
      error: exceptionDetails(cause, [token]),
    });
  } finally {
    reader?.releaseLock();
  }
}

const CodexUsageEvent = Schema.Struct({
  type: Schema.Literal("dolly.codex.usage"),
  headers: Schema.Record(Schema.String, Schema.String),
});

/** Route only Codex inference to the CLI; login and refresh retain their owner. */
export function containerCodex<TOptions extends StreamOptions>(
  env: Env,
  stream: StreamFunction<"openai-codex-responses", TOptions>,
  onUsage?: (headers: Record<string, string>) => void,
): StreamFunction<"openai-codex-responses", TOptions> {
  return (model, context, options) => {
    const onProviderStreamEvent: NonNullable<StreamOptions["onProviderStreamEvent"]> = async (
      event,
      selected,
    ) => {
      await options?.onProviderStreamEvent?.(event, selected);
      const usage = Schema.decodeUnknownOption(CodexUsageEvent)(event);

      if (Option.isSome(usage)) onUsage?.(usage.value.headers);
    };

    return stream(
      {
        ...model,
        // The CLI owns tool declarations. Ask Pi for the current flat tool set,
        // rather than Responses-only additional_tools/tool_search history items.
        compat: { ...model.compat, supportsAdditionalTools: false, supportsToolSearch: false },
      },
      context,
      Object.assign({}, options, {
        transport: "sse",
        maxRetries: 0,
        onProviderStreamEvent,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const id = crypto.randomUUID();
          const stub = env.CODEX.getByName(options?.sessionId ?? crypto.randomUUID());
          const signal = options?.signal;

          const abort = () => {
            void stub.cancel(id).catch(() => {
              console.warn("Codex cancellation delivery failed");
            });
          };

          const cleanup = () => signal?.removeEventListener("abort", abort);

          signal?.throwIfAborted();
          signal?.addEventListener("abort", abort, { once: true });
          request.headers.set("x-dolly-context-window", String(model.contextWindow));
          request.headers.set("x-dolly-request-id", id);

          try {
            const response = await stub.fetch(request);
            const reader = response.body?.getReader();

            if (!reader) {
              cleanup();

              return response;
            }

            return new Response(
              new ReadableStream({
                async pull(output) {
                  try {
                    const next = await reader.read();

                    if (next.done) {
                      cleanup();
                      output.close();
                    } else output.enqueue(next.value);
                  } catch (error) {
                    cleanup();
                    output.error(error);
                  }
                },
                async cancel() {
                  cleanup();
                  await stub.cancel(id);
                  await reader.cancel();
                },
              }),
              response,
            );
          } catch (error) {
            cleanup();
            throw error;
          }
        },
      }),
    );
  };
}

/** Isolated inference container: no checkout, refresh token, or public route. */
export class Codex extends DurableObject<Env> {
  private readonly requests = new Map<string, AbortController>();
  private starting?: Promise<void>;

  private startContainer(container: Container) {
    // Cold starts can exceed the DO input gate's 30-second deadline. Share the
    // startup promise without blocking incoming cancellation or resetting the DO.
    this.starting ??= (async () => {
      if (!container.running)
        container.start({
          image: container.images.codex,
          instance: "basic",
          enableInternet: true,
        });
      await container.setInactivityTimeout(300_000);
    })().finally(() => {
      this.starting = undefined;
    });

    return this.starting;
  }

  cancel(id: string) {
    const controller = this.requests.get(id) ?? new AbortController();

    controller.abort();
    this.requests.set(id, controller);
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;

    if (!container) throw new Error("Configure a container for Codex");

    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/backend-api/codex/responses"
    )
      return new Response("Not found", { status: 404 });
    const accessToken = request.headers.get("Authorization")?.replace(/^Bearer /, "");

    if (!accessToken) return new Response("Missing Codex access token", { status: 401 });
    const bytes = new Uint8Array(await request.arrayBuffer());

    if (bytes.byteLength > 16 * 1024 * 1024)
      return new Response("Codex request too large", { status: 413 });

    const decoded =
      request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(bytes, { maxOutputLength: 16 * 1024 * 1024 })
        : bytes;

    const body: unknown = JSON.parse(new TextDecoder().decode(decoded));
    const startedAt = Date.now();
    const id = request.headers.get("x-dolly-request-id") ?? crypto.randomUUID();

    console.info({ event: "codex_container_start", requestId: id, running: container.running });

    try {
      await this.startContainer(container);
    } catch (cause) {
      console.error({
        event: "codex_container_start_failed",
        requestId: id,
        elapsedMs: Date.now() - startedAt,
        error: exceptionDetails(cause, [accessToken]),
      });
      throw cause;
    }

    const controller = new AbortController();
    const cancellation = this.requests.get(id) ?? controller;
    const abort = () => controller.abort();

    this.requests.set(id, cancellation);
    cancellation.signal.addEventListener("abort", abort, { once: true });

    if (cancellation.signal.aborted) abort();
    request.signal.addEventListener("abort", abort, { once: true });

    if (request.signal.aborted) abort();
    let process: ExecProcess;

    try {
      process = await container.exec(["node", "/usr/local/lib/dolly-codex.mjs"], {
        stdin: new Response(
          JSON.stringify({
            accessToken,
            body,
            contextWindow: Number(request.headers.get("x-dolly-context-window")) || 128000,
          }),
        ).body!,
        signal: controller.signal,
      });
    } catch (cause) {
      request.signal.removeEventListener("abort", abort);
      cancellation.signal.removeEventListener("abort", abort);
      this.requests.delete(id);

      if (controller.signal.aborted) return new Response(null, { status: 499 });

      console.error({
        event: "codex_process_start_failed",
        requestId: id,
        error: exceptionDetails(cause, [accessToken]),
      });
      throw new Error("Unable to start Codex container process");
    }

    if (!process.stdout) throw new Error("Codex CLI stdout is unavailable");
    this.ctx.waitUntil(logCodexExit(process, id, accessToken, startedAt));
    const reader = process.stdout.getReader();

    const cleanup = async (cancel = false) => {
      request.signal.removeEventListener("abort", abort);
      cancellation.signal.removeEventListener("abort", abort);
      this.requests.delete(id);

      if (cancel) process.kill(15);
      await process.exitCode;
    };

    const output = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const next = await reader.read();

          if (next.done) {
            await cleanup();
            stream.close();
          } else stream.enqueue(next.value);
        } catch {
          await cleanup(true);
          stream.error(new Error("Codex container stream failed"));
        }
      },
      async cancel() {
        await cleanup(true);
        await reader.cancel();
      },
    });

    return new Response(output, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }
}
