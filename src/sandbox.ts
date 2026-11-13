import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { WorkspaceOutbound, type WorkspaceOutboundProps } from "./git-transport";
import {
  checkoutScript,
  checkoutDiagnosticsScript,
  restoreScript,
  type WorkspaceConfig,
  type WorkspaceCheckpoint,
  type WorkspaceSnapshot,
  type WorkspaceSetup,
} from "./workspace";
import { attempt, OperationError } from "./operations";
import { exceptionDetails, redact } from "./diagnostics";
import type { Env } from "./env";

/** Drain output without retaining unbounded bytes. Scoped cancellation releases the stream reader. */
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
  private prepared = false;
  private setupAbort: AbortController | undefined;
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

    if (!container.running || !this.initialized) {
      const workspace = yield* attempt("workspace.read", () =>
        this.ctx.storage.get<WorkspaceConfig>("workspace"),
      );

      const snapshot = yield* attempt("workspace.snapshot.read", () =>
        this.ctx.storage.get<WorkspaceSnapshot>("snapshot:checkpoint"),
      );

      const legacy = yield* attempt("workspace.legacy.read", () =>
        this.ctx.storage.get<WorkspaceCheckpoint>("artifact:checkpoint"),
      );

      const backend = yield* attempt("workspace.backend.read", () =>
        this.ctx.storage.get<string>("workspace:backend"),
      );

      if (legacy && !snapshot && !this.env.WORKSPACES)
        return yield* new OperationError({
          operation: "workspace.migration",
          message: "Enable DOLLY_LEGACY_ARTIFACTS=true when deploying to import this checkpoint",
          details: null,
        });

      // An older running image may contain unacknowledged work on a FUSE mount.
      // Never kill it or snapshot a mount that native snapshots would omit.
      if (container.running && workspace && backend !== "local-v1")
        return yield* new OperationError({
          operation: "workspace.migration",
          message: "Legacy sandbox is still running; preserve unsaved work before replacing it",
          details: null,
        });

      if (
        !snapshot &&
        !legacy &&
        (yield* attempt("workspace.legacy.read", () => this.ctx.storage.get("checkpoint")))
      )
        return yield* new OperationError({
          operation: "workspace.migration",
          message: "An R2 workspace checkpoint exists; export it before starting a new workspace",
          details: null,
        });

      if (!container.running) {
        // A missing/expired snapshot is an error, never permission to start empty.
        yield* attempt("workspace.start", () =>
          Promise.resolve(
            container.start({
              ...(snapshot
                ? { containerSnapshot: { id: snapshot.id } }
                : { image: container.images.sandbox }),
              instance: "standard-1",
              enableInternet: false,
            }),
          ),
        );
        yield* attempt("workspace.backend.save", () =>
          this.ctx.storage.put("workspace:backend", "local-v1"),
        );
        this.initialized = false;
        this.prepared = false;
      }

      if (workspace) {
        const props: WorkspaceOutboundProps = { ...workspace };

        if (!snapshot && legacy) props.artifactRepository = this.artifactRepository;

        const outbound = this.loopback.WorkspaceOutbound({
          props,
        });

        yield* attempt("workspace.network.http", () =>
          container.interceptAllOutboundHttp(outbound),
        );
        yield* attempt("workspace.network.https", () =>
          container.interceptOutboundHttps("*", outbound),
        );

        if (!snapshot && legacy) {
          this.initialized = true;

          const restored = yield* this.execute(
            restoreScript(this.artifactRepository, legacy),
            "/workspace",
            120,
            container,
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
              message: "Legacy workspace import failed; original checkpoint retained",
              details: restored,
            });
          }

          yield* this.checkpoint().pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                this.initialized = false;
              }),
            ),
          );
          // Revoke the migration-only outbound capability after publication.
          const localOutbound = this.loopback.WorkspaceOutbound({ props: workspace });
          yield* attempt("workspace.network.http", () =>
            container.interceptAllOutboundHttp(localOutbound),
          );
          yield* attempt("workspace.network.https", () =>
            container.interceptOutboundHttps("*", localOutbound),
          );
        } else if (snapshot) {
          // start() is lazy. Force a real operation before reporting ready so a
          // missing/expired snapshot cannot masquerade as a restored workspace.
          this.initialized = true;

          const restored = yield* this.execute(
            "test -f /workspace/ready && test -d /workspace/repo/.git",
            "/workspace",
            120,
            container,
          ).pipe(
            Effect.mapError(
              (error) =>
                new OperationError({
                  operation: "workspace.restore",
                  message: `Unable to restore snapshot ${snapshot.id}: ${exceptionDetails(error).message}`,
                  details: null,
                }),
            ),
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
              message: "Snapshot is missing a prepared local workspace; refusing to clone over it",
              details: { snapshotId: snapshot.id },
            });
          }
        }

        this.prepared = Boolean(snapshot || legacy);
      }

      this.initialized = true;
    }

    yield* attempt("sandbox.inactivity", () => container.setInactivityTimeout(300_000));

    return container;
  });

  private execute = Effect.fn("Sandbox.execute")(function* (
    this: Sandbox,
    command: string,
    cwd: string,
    timeout = 60,
    initializingContainer?: Container,
  ) {
    // Initialization probes must not recursively re-enter container() when a
    // lazy start fails (for example, an expired or missing snapshot).
    const container = initializingContainer ?? (yield* this.container());
    let exited = false;

    return yield* Effect.acquireUseRelease(
      attempt("sandbox.exec", (signal) =>
        container.exec(["python3", "/usr/local/lib/dolly-exec.py", command], {
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
          : attempt("sandbox.process.terminate", async () => {
              // The supervisor forwards TERM to the command's isolated group,
              // then escalates and waits. Do not kill just its shell.
              process.kill(15);
              await process.exitCode;
            }).pipe(
              Effect.timeout("5 seconds"),
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.try(() => process.kill(9)).pipe(Effect.ignore);
                  yield* Effect.logWarning({
                    event: "process_cleanup_failed",
                    error: redact(Cause.pretty(cause)),
                  });
                }),
              ),
            ),
    ).pipe(Effect.timeout(`${timeout} seconds`));
  });

  private checkpoint = Effect.fn("Sandbox.checkpoint")(function* (this: Sandbox) {
    const workspace = yield* attempt("workspace.read", () => this.ctx.storage.get("workspace"));

    if (!workspace) return;

    const container = yield* this.container();
    const started = Date.now();
    yield* Effect.logInfo({
      event: "workspace_checkpoint_started",
      sandboxId: String(this.ctx.id),
    });

    const snapshot = yield* attempt("workspace.checkpoint", () =>
      container.snapshotContainer({ name: `workspace-${crypto.randomUUID()}` }),
    ).pipe(
      Effect.timeout("120 seconds"),
      Effect.onError((cause) =>
        Effect.logError({
          event: "workspace_checkpoint_failed",
          sandboxId: String(this.ctx.id),
          elapsedMs: Date.now() - started,
          error: redact(Cause.pretty(cause)),
        }),
      ),
    );

    // Publish only after capture succeeds. An unacknowledged snapshot cannot
    // replace the last recoverable checkpoint in Durable Object storage.
    yield* this.publishSnapshot({ id: snapshot.id });
    yield* Effect.logInfo({
      event: "workspace_checkpoint_succeeded",
      sandboxId: String(this.ctx.id),
      snapshotId: snapshot.id,
      size: snapshot.size,
      elapsedMs: Date.now() - started,
    });
  });

  private publishSnapshot(snapshot: WorkspaceSnapshot) {
    return attempt("workspace.checkpoint.save", () =>
      this.ctx.storage.put("snapshot:checkpoint", snapshot),
    );
  }

  private checkout = Effect.fn("Sandbox.checkout")(function* (
    this: Sandbox,
    config: WorkspaceConfig,
  ) {
    const started = Date.now();
    const context = { sandboxId: this.ctx.id.toString(), timeoutSeconds: 120 };
    yield* Effect.logInfo({ event: "workspace_checkout_started", ...context });

    return yield* Effect.gen({ self: this }, function* () {
      const result = yield* this.execute(checkoutScript(config), "/workspace", 120);

      if (result.exitCode !== 0)
        return yield* new OperationError({
          operation: "workspace.checkout",
          message: `Git checkout failed (exit ${result.exitCode}): ${redact(
            (result.stderr.trim() || result.stdout.trim() || "No command output").slice(-2000),
          )}`,
          details: {
            ...result,
            stdout: redact(result.stdout),
            stderr: redact(result.stderr),
          },
        });

      yield* Effect.logInfo({
        event: "workspace_checkout_succeeded",
        ...context,
        elapsedMs: Date.now() - started,
      });
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen({ self: this }, function* () {
          // Log before collecting diagnostics so a failed/hung probe cannot hide the original failure.
          yield* Effect.logError({
            event: "workspace_checkout_failed",
            ...context,
            elapsedMs: Date.now() - started,
            error: redact(Cause.pretty(cause)),
          });
          const diagnostics = yield* this.execute(checkoutDiagnosticsScript, "/workspace", 10);
          yield* Effect.logWarning({
            event: "workspace_checkout_diagnostics",
            ...context,
            exitCode: diagnostics.exitCode,
            stdout: redact(diagnostics.stdout),
            stderr: redact(diagnostics.stderr),
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning({
              event: "workspace_checkout_diagnostics_failed",
              ...context,
              error: redact(Cause.pretty(cause)),
            }),
          ),
        ),
      ),
    );
  });

  private setupStatus(state: WorkspaceSetup["state"], error?: string) {
    const status: WorkspaceSetup = { state, updatedAt: Date.now() };

    if (error) status.error = redact(error).slice(-2000);

    return attempt("workspace.setup.status", () =>
      this.ctx.storage.put("workspace:setup", status),
    ).pipe(
      Effect.tap(() =>
        Effect.logInfo({
          event: "workspace_setup",
          sandboxId: String(this.ctx.id),
          ...status,
        }),
      ),
    );
  }

  private installDependencies = Effect.fn("Sandbox.installDependencies")(function* (
    this: Sandbox,
    config: WorkspaceConfig,
  ) {
    const container = yield* this.container();

    // Only the setup job gets the two public package registries. GitHub and
    // model credentials still stay in the Worker; no general Internet access.
    const setupOutbound = this.loopback.WorkspaceOutbound({
      props: {
        ...config,
        networkHosts: [...config.networkHosts, "registry.npmjs.org", "registry.yarnpkg.com"],
      },
    });

    const normalOutbound = this.loopback.WorkspaceOutbound({ props: config });

    const apply = (outbound: typeof normalOutbound) =>
      Effect.gen(function* () {
        yield* attempt("workspace.network.http", () =>
          container.interceptAllOutboundHttp(outbound),
        );
        yield* attempt("workspace.network.https", () =>
          container.interceptOutboundHttps("*", outbound),
        );
      });

    return yield* Effect.gen({ self: this }, function* () {
      yield* apply(setupOutbound);

      const result = yield* this.execute(
        "python3 /usr/local/lib/dolly-setup.py",
        "/workspace/repo",
        900,
      );

      return result.exitCode === 0
        ? undefined
        : redact(result.stderr || result.stdout || `Setup exited ${result.exitCode}`).slice(-2000);
    }).pipe(
      Effect.catchCause((cause) => Effect.succeed(redact(Cause.pretty(cause)).slice(-2000))),
      // Failure to restore the restricted broker is fatal, not best-effort.
      Effect.ensuring(apply(normalOutbound).pipe(Effect.orDie)),
    );
  });

  /** Persist intent before returning; tools join the same serialized prepare. */
  async warm(config: WorkspaceConfig) {
    const existing = await this.ctx.storage.get<WorkspaceConfig>("workspace");

    if (existing && JSON.stringify(existing) !== JSON.stringify(config))
      throw new OperationError({
        operation: "workspace.configure",
        message: "This conversation already owns a different workspace",
        details: null,
      });

    if (!existing) {
      await this.ctx.storage.put("workspace", config);
      this.initialized = false;
      await Effect.runPromise(this.setupStatus("queued"));
    }

    await this.ctx.storage.setAlarm(Date.now() + 1000);
    this.ctx.waitUntil(
      this.prepare(config).catch(async (error) => {
        await Effect.runPromise(this.setupStatus("failed", exceptionDetails(error).message));
      }),
    );

    return { queued: true };
  }

  async alarm() {
    const config = await this.ctx.storage.get<WorkspaceConfig>("workspace");

    if (config) {
      try {
        await this.prepare(config);
      } catch (error) {
        await Effect.runPromise(this.setupStatus("failed", exceptionDetails(error).message));
      }
    }
  }

  prepare(config: WorkspaceConfig) {
    const controller = (this.setupAbort ??= new AbortController());

    return Effect.runPromise(
      this.permit
        .withPermit(
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
              yield* attempt("workspace.configure", () =>
                this.ctx.storage.put("workspace", config),
              );
              this.initialized = false;
            }

            // Initialize/restore first so a restarted container never uses a stale warm flag.
            yield* this.container();

            const info = {
              repository: config.repository,
              branch: config.branch,
              ref: config.ref ?? "HEAD",
            };

            if (this.prepared)
              return {
                ...info,
                setup: yield* attempt("workspace.setup.read", () =>
                  this.ctx.storage.get<WorkspaceSetup>("workspace:setup"),
                ),
              };

            yield* this.setupStatus("checkout");
            yield* this.checkout(config);
            yield* this.setupStatus("installing");
            const warning = yield* this.installDependencies(config);
            yield* this.checkpoint();
            yield* this.setupStatus(warning ? "warning" : "ready", warning);
            this.prepared = true;

            return {
              ...info,
              setup: yield* attempt("workspace.setup.read", () =>
                this.ctx.storage.get<WorkspaceSetup>("workspace:setup"),
              ),
            };
          }),
        )
        .pipe(
          Effect.onError((cause) =>
            this.setupStatus("failed", redact(Cause.pretty(cause))).pipe(Effect.ignore),
          ),
        ),
      { signal: controller.signal },
    ).finally(() => {
      if (this.setupAbort === controller) this.setupAbort = undefined;
    });
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

  diagnostics() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        // Deliberately bypass container()/prepare(): even an old or broken
        // checkout must remain inspectable, without starting an empty instance.
        const container = this.ctx.container;

        const setup = yield* attempt("workspace.setup.read", () =>
          this.ctx.storage.get<WorkspaceSetup>("workspace:setup"),
        );

        if (!container?.running) return { running: false, setup };

        return yield* Effect.acquireUseRelease(
          attempt("sandbox.diagnostics", () =>
            container.exec(["sh", "-c", checkoutDiagnosticsScript], { cwd: "/workspace" }),
          ),
          (process) =>
            Effect.all(
              {
                running: Effect.succeed(true),
                setup: Effect.succeed(setup),
                stdout: readBounded(process.stdout, { limit: 32_768, overflow: "truncate" }).pipe(
                  Effect.map(redact),
                ),
                stderr: readBounded(process.stderr, { limit: 32_768, overflow: "truncate" }).pipe(
                  Effect.map(redact),
                ),
                exitCode: attempt("sandbox.diagnostics.exit", () => process.exitCode),
              },
              { concurrency: "unbounded" },
            ),
          (process) => Effect.try(() => process.kill(15)).pipe(Effect.ignore),
        ).pipe(Effect.timeout("10 seconds"));
      }),
    );
  }

  async restart() {
    // Do not queue a restart behind a hung dependency install.
    this.setupAbort?.abort();

    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          if (this.ctx.container?.running)
            yield* attempt("workspace.restart", () => this.ctx.container!.destroy());
          this.initialized = false;
          this.prepared = false;
        }),
      ),
    );
  }
}
