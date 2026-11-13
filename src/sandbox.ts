import { DurableObject } from "cloudflare:workers";
import {
  Files,
  DirectoryBackup,
  DirectoryBackupGateway,
  type DirectoryBackupRecord,
} from "@cloudflare/sandbox";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { WorkspaceOutbound } from "./git-transport";
import { checkoutScript, type WorkspaceConfig } from "./workspace";
import { attempt, OperationError } from "./operations";
import { exceptionDetails } from "./diagnostics";
import type { Env } from "./env";

/** Drain output without retaining unbounded bytes. Scoped cancellation releases the native reader. */
export const readBounded = Effect.fn("Sandbox.readBounded")(function* (
  stream: ReadableStream<Uint8Array> | null,
  options: { readonly limit: number; readonly overflow: "truncate" | "fail" },
) {
  if (!stream) return "";

  return yield* Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const bytes = new Uint8Array(options.limit);
        let retained = 0;

        while (true) {
          const chunk = yield* attempt("sandbox.stream.read", () => reader.read());

          if (chunk.done) return new TextDecoder().decode(bytes.subarray(0, retained));

          if (options.overflow === "fail" && retained + chunk.value.byteLength > options.limit) {
            return yield* new OperationError({
              operation: "sandbox.file.read",
              message: "File exceeds 64 KiB; use a shell command to read a range",
              details: { limit: options.limit },
            });
          }

          const prefix = chunk.value.subarray(0, bytes.length - retained);
          bytes.set(prefix, retained);
          retained += prefix.length;
        }
      }),
    (reader) =>
      attempt("sandbox.stream.cancel", () => reader.cancel()).pipe(
        Effect.catch((cause) =>
          Effect.logWarning({ event: "stream_cleanup_failed", error: exceptionDetails(cause) }),
        ),
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      ),
  );
});

interface SandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    WorkspaceOutbound: LoopbackForExport<typeof WorkspaceOutbound>;
    DirectoryBackupGateway: LoopbackForExport<typeof DirectoryBackupGateway>;
  };
}

export class Sandbox extends DurableObject<Env> {
  private readonly permit = Semaphore.makeUnsafe(1);
  private initialized = false;
  private backup?: DirectoryBackup;
  private readonly loopback: SandboxState["exports"];

  constructor(ctx: SandboxState, env: Env) {
    super(ctx, env);
    this.loopback = ctx.exports;
  }

  private container = Effect.fn("Sandbox.container")(function* (this: Sandbox) {
    const container = this.ctx.container;

    if (!container) return yield* Effect.die("Sandbox Container binding is not configured");
    const started = !container.running;

    if (started) {
      container.start({ image: container.images.sandbox, enableInternet: false });
      this.initialized = false;
    }

    yield* attempt("sandbox.inactivity", () => container.setInactivityTimeout(300_000));

    if (!this.initialized) {
      const workspace = yield* attempt("workspace.read", () =>
        this.ctx.storage.get<WorkspaceConfig>("workspace"),
      );

      if (workspace) {
        const backup = new DirectoryBackup(container, this.loopback.DirectoryBackupGateway, {
          binding: "WORKSPACES",
          prefix: `workspaces/${this.ctx.id}/`,
        });

        this.backup = backup;
        yield* attempt("workspace.backup.intercept", () => backup.intercept());
        const outbound = this.loopback.WorkspaceOutbound({ props: workspace });
        yield* attempt("workspace.network.http", () =>
          container.interceptAllOutboundHttp(outbound),
        );
        yield* attempt("workspace.network.https", () =>
          container.interceptOutboundHttps("*", outbound),
        );

        const saved = yield* attempt("workspace.checkpoint.read", () =>
          this.ctx.storage.get<DirectoryBackupRecord>("checkpoint"),
        );

        if (started && saved) yield* attempt("workspace.restore", () => backup.restore(saved));
      }

      this.initialized = true;
    }

    return container;
  });

  private execute = Effect.fn("Sandbox.execute")(function* (
    this: Sandbox,
    command: string,
    cwd: string,
  ) {
    const container = yield* this.container();
    let exited = false;

    return yield* Effect.acquireUseRelease(
      attempt("sandbox.exec", (signal) =>
        container.exec(["sh", "-lc", command], {
          cwd,
          signal,
          env: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            CURL_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
            SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
            NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
          },
        }),
      ),
      (process) =>
        Effect.all(
          {
            stdout: readBounded(process.stdout, { limit: 32_768, overflow: "truncate" }),
            stderr: readBounded(process.stderr, { limit: 32_768, overflow: "truncate" }),
            exitCode: attempt("sandbox.exit", () => process.exitCode).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  exited = true;
                }),
              ),
            ),
          },
          { concurrency: "unbounded" },
        ),
      (process) =>
        exited
          ? Effect.void
          : Effect.try(() => process.kill()).pipe(
              Effect.catch((cause) =>
                Effect.logWarning({
                  event: "process_cleanup_failed",
                  error: exceptionDetails(cause),
                }),
              ),
            ),
    ).pipe(Effect.timeout("60 seconds"));
  });

  private checkpoint = Effect.fn("Sandbox.checkpoint")(function* (this: Sandbox) {
    const backup = this.backup;

    if (!backup) return;

    const previous = yield* attempt("workspace.checkpoint.read", () =>
      this.ctx.storage.get<DirectoryBackupRecord>("checkpoint"),
    );

    const next = yield* attempt("workspace.backup", () =>
      backup.backup({ dir: "/workspace/repo" }),
    );

    yield* attempt("workspace.checkpoint.save", () => this.ctx.storage.put("checkpoint", next));

    if (previous)
      yield* attempt("workspace.backup.delete", () => backup.delete(previous)).pipe(
        Effect.catch((error) =>
          Effect.logWarning({ event: "workspace_cleanup_failed", error: exceptionDetails(error) }),
        ),
      );
  });

  prepare(config: WorkspaceConfig) {
    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          const existing = yield* attempt("workspace.read", () =>
            this.ctx.storage.get<WorkspaceConfig>("workspace"),
          );

          if (existing && JSON.stringify(existing) !== JSON.stringify(config))
            return yield* new OperationError({
              operation: "workspace.configure",
              message: "This conversation already owns a different workspace",
              details: null,
            });

          if (!existing) {
            yield* attempt("workspace.configure", () => this.ctx.storage.put("workspace", config));
            this.initialized = false;
          }

          const result = yield* this.execute(checkoutScript(config), "/workspace");

          if (result.exitCode !== 0)
            return yield* new OperationError({
              operation: "workspace.checkout",
              message: "Git checkout failed",
              details: result,
            });

          if (!existing) yield* this.checkpoint();

          return {
            repository: config.repository,
            branch: config.branch,
            ref: config.ref ?? "HEAD",
          };
        }),
      ),
    );
  }

  run(command: string) {
    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          const workspace = yield* attempt("workspace.read", () =>
            this.ctx.storage.get("workspace"),
          );

          return yield* this.execute(command, workspace ? "/workspace/repo" : "/workspace").pipe(
            Effect.ensuring(this.checkpoint().pipe(Effect.timeout("120 seconds"), Effect.orDie)),
          );
        }),
      ),
    );
  }

  readFile(path: string) {
    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          const container = yield* this.container();

          const response = yield* attempt("sandbox.file.open", (signal) =>
            new Files(container).readFile(path, { signal }),
          );

          return yield* readBounded(response.body, { limit: 65_536, overflow: "fail" });
        }).pipe(Effect.timeout("60 seconds")),
      ),
    );
  }

  async restart() {
    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          if (this.ctx.container?.running)
            yield* attempt("workspace.restart", () => this.ctx.container!.destroy());
          this.initialized = false;
        }),
      ),
    );
  }
}
