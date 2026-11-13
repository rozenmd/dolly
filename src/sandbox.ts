import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { WorkspaceOutbound } from "./git-transport";
import {
  checkoutScript,
  restoreScript,
  checkpointScript,
  type WorkspaceConfig,
  type WorkspaceCheckpoint,
} from "./workspace";
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
  };
}

export class Sandbox extends DurableObject<Env> {
  private readonly permit = Semaphore.makeUnsafe(1);
  private initialized = false;
  private readonly artifactRepository = `session-${this.ctx.id}`;
  private readonly loopback: SandboxState["exports"];

  constructor(ctx: SandboxState, env: Env) {
    super(ctx, env);
    this.loopback = ctx.exports;
  }

  private container = Effect.fn("Sandbox.container")(function* (
    this: Sandbox,
  ): Effect.fn.Return<Container, OperationError | Cause.TimeoutError> {
    const container = this.ctx.container;

    if (!container) return yield* Effect.die("Sandbox Container binding is not configured");

    if (!container.running) {
      container.start({ image: container.images.sandbox, enableInternet: false });
      this.initialized = false;
    }

    yield* attempt("sandbox.inactivity", () => container.setInactivityTimeout(300_000));

    if (!this.initialized) {
      const workspace = yield* attempt("workspace.read", () =>
        this.ctx.storage.get<WorkspaceConfig>("workspace"),
      );

      if (workspace) {
        yield* attempt("artifacts.repository", async () => {
          try {
            using repo = await this.env.WORKSPACES.get(this.artifactRepository);
            await repo.info();
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "NOT_FOUND")
              throw error;
            await this.env.WORKSPACES.create(this.artifactRepository);
          }
        });

        const outbound = this.loopback.WorkspaceOutbound({
          props: { ...workspace, artifactRepository: this.artifactRepository },
        });

        yield* attempt("workspace.network.http", () =>
          container.interceptAllOutboundHttp(outbound),
        );
        yield* attempt("workspace.network.https", () =>
          container.interceptOutboundHttps("*", outbound),
        );

        const saved = yield* attempt("workspace.checkpoint.read", () =>
          this.ctx.storage.get<WorkspaceCheckpoint>("artifact:checkpoint"),
        );

        if (
          !saved &&
          (yield* attempt("workspace.legacy.read", () => this.ctx.storage.get("checkpoint")))
        )
          return yield* new OperationError({
            operation: "workspace.migration",
            message: "An R2 workspace checkpoint exists; migrate it before using Artifacts",
            details: null,
          });

        if (saved) {
          this.initialized = true;

          const restored = yield* this.execute(
            restoreScript(this.artifactRepository, saved),
            "/workspace",
            120,
          ).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                this.initialized = false;
              }),
            ),
          );

          if (restored.exitCode !== 0) {
            this.initialized = false;

            return yield* new OperationError({
              operation: "workspace.restore",
              message: "Artifact workspace restore failed",
              details: restored,
            });
          }
        }
      }

      this.initialized = true;
    }

    return container;
  });

  private execute = Effect.fn("Sandbox.execute")(function* (
    this: Sandbox,
    command: string,
    cwd: string,
    timeout = 60,
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
    ).pipe(Effect.timeout(`${timeout} seconds`));
  });

  private checkpoint = Effect.fn("Sandbox.checkpoint")(function* (this: Sandbox) {
    const workspace = yield* attempt("workspace.read", () => this.ctx.storage.get("workspace"));

    if (!workspace) return;

    const previous = yield* attempt("workspace.checkpoint.read", () =>
      this.ctx.storage.get<WorkspaceCheckpoint>("artifact:checkpoint"),
    );

    // Immutable refs keep a pushed-but-unacknowledged checkpoint from replacing the last good one.
    const branch = `checkpoint-${crypto.randomUUID()}`;

    const result = yield* this.execute(
      checkpointScript(this.artifactRepository, branch, previous),
      "/workspace",
      120,
    );

    const commit = result.stdout.trim();

    if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit))
      return yield* new OperationError({
        operation: "workspace.checkpoint",
        message: "Artifact checkpoint failed",
        details: result,
      });
    yield* attempt("workspace.checkpoint.save", () =>
      this.ctx.storage.put("artifact:checkpoint", { branch, commit } satisfies WorkspaceCheckpoint),
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

          const result = yield* this.execute(checkoutScript(config), "/workspace", 120);

          if (result.exitCode !== 0) {
            yield* Effect.logError({ event: "workspace_checkout_failed", ...result });

            return yield* new OperationError({
              operation: "workspace.checkout",
              message: "Git checkout failed",
              details: result,
            });
          }

          yield* this.checkpoint();

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
