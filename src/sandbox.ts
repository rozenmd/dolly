import { DurableObject } from "cloudflare:workers";
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { WorkspaceOutbound } from "./git-transport";
import {
  checkoutScript,
  checkoutDiagnosticsScript,
  restoreNotice,
  type WorkspaceConfig,
  type WorkspaceRestore,
  type WorkspaceSnapshot,
  type WorkspaceSetup,
  shellQuote,
} from "./workspace";
import { attempt, OperationError } from "./operations";
import { LineWindow, describeWindow, type FileRange } from "./file-window";
import { applyEdit, diffStats, MAX_EDIT_BYTES, type DiffStats, type Edit } from "./file-edit";
import { exceptionDetails, redact } from "./diagnostics";
import type { Env } from "./env";
import { PREVIEW_TTL_MS, PreviewPort } from "./preview";
import * as Schema from "effect/Schema";
import previewSupervisor from "../container/preview.py?raw";
import skillsInventory from "../container/skills.py?raw";

const PREVIEW_DIRECTORY = "/workspace/.dolly-preview";
const PREVIEW_SUPERVISOR = `${PREVIEW_DIRECTORY}/supervisor.py`;
const PREVIEW_LOG = `${PREVIEW_DIRECTORY}/preview.log`;

type RunningPreview = {
  token: string;
  port: number;
  expiresAt: number;
  process: ExecProcess;
  exited: boolean;
};

type InitializationTiming = {
  operation: string;
  startedAt: number;
  state: "running" | "succeeded" | "failed" | "interrupted";
  elapsedMs?: number;
};

type ContainerInitialization = InitializationTiming & {
  id: string;
  wasRunning: boolean;
  restoringSnapshot: boolean;
  steps: InitializationTiming[];
};

/** Drain output without retaining unbounded bytes. Scoped cancellation releases the stream reader. */
export const readBounded = Effect.fn("Sandbox.readBounded")(function* (
  stream: ReadableStream<Uint8Array> | null,
  options: { readonly limit: number },
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

/** Stream a file through a line window, cancelling the read once the window is full. */
export const readWindow = Effect.fn("Sandbox.readWindow")(function* (
  stream: ReadableStream<Uint8Array> | null,
  range: FileRange,
) {
  const window = new LineWindow(range);

  if (stream)
    yield* Effect.acquireUseRelease(
      Effect.sync(() => stream.getReader()),
      (reader) =>
        Effect.gen(function* () {
          const decoder = new TextDecoder();

          while (true) {
            const chunk = yield* attempt("sandbox.stream.read", () => reader.read());

            if (chunk.done) {
              window.push(decoder.decode());

              return;
            }

            if (window.push(decoder.decode(chunk.value, { stream: true }))) return;
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

  const complete = !window.done;

  return describeWindow(window.finish(), complete ? window.totalLines : undefined);
});

/** The container filesystem operations the file tools use. */
type FileSystem = Pick<Files, "stat" | "readFile" | "writeFile" | "mkdir">;

/** A file tool result: the file's absolute path and its line-level change. */
export type FileChange = DiffStats & {
  readonly path: string;
  /** write_file only: the file did not exist before. */
  readonly created?: boolean;
  /** edit_file only: how many matches of old_string were replaced. */
  readonly replacements?: number;
};

/**
 * A file tool request the model can correct (a missing or ambiguous match, a
 * directory, binary or oversized file). It is returned as data rather than thrown
 * across RPC, which is reserved for sandbox and transport failures.
 */
class FileRefusal extends Schema.TaggedError<FileRefusal>()("FileRefusal", {
  message: Schema.String,
}) {}

/** A completed change, or why the request was refused without touching the file. */
export type FileResult = { readonly change: FileChange } | { readonly refused: string };

const refuse = (message: string) => new FileRefusal({ message });

const fileResult = (operation: Effect.Effect<FileChange, FileRefusal | OperationError>) =>
  operation.pipe(
    Effect.map((change): FileResult => ({ change })),
    Effect.catchTag("FileRefusal", (refusal) =>
      Effect.succeed<FileResult>({ refused: refusal.message }),
    ),
  );

/** A file's metadata, or null when nothing exists at the path. */
async function statIfPresent(files: FileSystem, path: string, signal: AbortSignal) {
  try {
    return await files.stat(path, { signal });
  } catch (cause) {
    if (SandboxFileError.is(cause) && cause.code === "ENOENT") return null;

    throw cause;
  }
}

/** A whole UTF-8 file for editing, or null when it does not exist yet. */
const readText = Effect.fn("Sandbox.readText")(function* (files: FileSystem, path: string) {
  const stat = yield* attempt("sandbox.file.stat", (signal) => statIfPresent(files, path, signal));

  if (!stat) return null;

  if (stat.type !== "file") return yield* refuse(`${path} is a ${stat.type}, not a regular file`);

  if (stat.size > BigInt(MAX_EDIT_BYTES))
    return yield* refuse(
      `${path} is larger than ${MAX_EDIT_BYTES / 1024 / 1024} MiB; change it with shell instead`,
    );

  const response = yield* attempt("sandbox.file.open", (signal) =>
    files.readFile(path, { signal }),
  );

  const bytes = yield* attempt("sandbox.file.read", () => response.arrayBuffer());

  // ignoreBOM keeps a byte-order mark in the text, so rewriting the file preserves it.
  return yield* attempt("sandbox.file.decode", async () =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  ).pipe(Effect.mapError(() => refuse(`${path} is not UTF-8 text; change it with shell instead`)));
});

const writeText = Effect.fn("Sandbox.writeText")(function* (
  files: FileSystem,
  path: string,
  content: string,
) {
  yield* attempt("sandbox.file.write", (signal) => files.writeFile(path, content, { signal }));
});

const writeChange = Effect.fn("Sandbox.writeChange")(function* (
  files: FileSystem,
  path: string,
  content: string,
) {
  const before = yield* readText(files, path);
  const parent = path.slice(0, path.lastIndexOf("/"));

  if (before === null && parent)
    yield* attempt("sandbox.file.mkdir", (signal) =>
      files.mkdir(parent, { recursive: true, signal }),
    );

  yield* writeText(files, path, content);

  const change: FileChange = {
    path,
    created: before === null,
    ...diffStats(before ?? "", content),
  };

  return change;
});

const editChange = Effect.fn("Sandbox.editChange")(function* (
  files: FileSystem,
  path: string,
  edit: Edit,
) {
  const before = yield* readText(files, path);

  if (before === null) return yield* refuse(`${path} does not exist; use write_file to create it`);

  const edited = applyEdit(before, path, edit);

  if (!edited.ok) return yield* refuse(edited.message);

  yield* writeText(files, path, edited.text);

  const change: FileChange = {
    path,
    replacements: edited.replacements,
    ...diffStats(before, edited.text),
  };

  return change;
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
  private setupOperations = 0;
  private dependencySetup: Promise<void> | undefined;
  private dependencyAbort: AbortController | undefined;
  private readonly loopback: SandboxState["exports"];
  private preview?: RunningPreview;
  private initialization?: ContainerInitialization;

  constructor(ctx: SandboxState, env: Env) {
    super(ctx, env);
    this.loopback = ctx.exports;
  }

  private timeInitialization = Effect.fn("Sandbox.timeInitialization")(function* <A, E>(
    this: Sandbox,
    initialization: ContainerInitialization,
    operation: string,
    effect: Effect.Effect<A, E>,
    retain = true,
  ) {
    const timing: InitializationTiming =
      operation === "total"
        ? initialization
        : { operation, startedAt: Date.now(), state: "running" };

    if (operation !== "total" && retain) initialization.steps.push(timing);

    const context = {
      sandboxId: String(this.ctx.id),
      initializationId: initialization.id,
      operation,
      wasRunning: initialization.wasRunning,
      reused: !retain,
    };

    yield* Effect.logInfo({
      event: "sandbox_initialization_step",
      ...context,
      phase: "started",
      startedAt: timing.startedAt,
    });

    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          timing.elapsedMs = Date.now() - timing.startedAt;
          timing.state = "succeeded";

          if (Exit.isFailure(exit))
            timing.state = Exit.hasInterrupts(exit) ? "interrupted" : "failed";

          yield* Effect.logInfo({
            event: "sandbox_initialization_step",
            ...context,
            phase: timing.state,
            elapsedMs: timing.elapsedMs,
            restoringSnapshot: initialization.restoringSnapshot,
          });
        }),
      ),
    );
  });

  private container = Effect.fn("Sandbox.container")(function* (
    this: Sandbox,
  ): Effect.fn.Return<Container, OperationError | Cause.TimeoutError> {
    const container = this.ctx.container;

    if (!container) return yield* Effect.die("Sandbox Container binding is not configured");

    if (container.running && this.initialized) {
      const inactivity = attempt("sandbox.inactivity", () =>
        container.setInactivityTimeout(300_000),
      );

      if (this.initialization)
        yield* this.timeInitialization(
          this.initialization,
          "sandbox.inactivity",
          inactivity,
          false,
        );
      else yield* inactivity;

      return container;
    }

    const initialization: ContainerInitialization = {
      id: crypto.randomUUID(),
      operation: "total",
      startedAt: Date.now(),
      state: "running",
      wasRunning: container.running,
      restoringSnapshot: false,
      steps: [],
    };

    this.initialization = initialization;

    return yield* this.timeInitialization(
      initialization,
      "total",
      Effect.gen({ self: this }, function* () {
        const workspace = yield* this.timeInitialization(
          initialization,
          "workspace.read",
          attempt("workspace.read", () => this.ctx.storage.get<WorkspaceConfig>("workspace")),
        );

        const wasRunning = container.running;

        const snapshot = yield* this.timeInitialization(
          initialization,
          "workspace.snapshot.read",
          attempt("workspace.snapshot.read", () =>
            this.ctx.storage.get<WorkspaceSnapshot>("snapshot:checkpoint"),
          ),
        );

        initialization.restoringSnapshot = !wasRunning && Boolean(snapshot);

        if (!wasRunning) {
          // Reap any installer belonging to the previous container before
          // authorizing or starting setup in its replacement.
          this.dependencyAbort?.abort();
          yield* this.timeInitialization(
            initialization,
            "workspace.dependencies.cleanup",
            attempt(
              "workspace.dependencies.cleanup",
              () => this.dependencySetup ?? Promise.resolve(),
            ),
          );
          this.dependencySetup = undefined;
          this.dependencyAbort = undefined;
          yield* this.timeInitialization(
            initialization,
            "workspace.start",
            attempt("workspace.start", () =>
              Promise.resolve(
                container.start({
                  ...(snapshot
                    ? { containerSnapshot: { id: snapshot.id } }
                    : { image: container.images.sandbox }),
                  instance: "standard-3",
                  enableInternet: false,
                }),
              ),
            ),
          );
          this.initialized = false;
          this.prepared = false;

          // The previous container held changes newer than the last save. They are
          // gone now; record it so the next repository tool says so explicitly.
          if (workspace)
            yield* this.timeInitialization(
              initialization,
              "workspace.restore.record",
              this.recordRestore(workspace, snapshot ?? null),
            );
        }

        if (workspace) {
          const outbound = this.loopback.WorkspaceOutbound({
            props: { ...workspace, sandbox: String(this.ctx.id) },
          });

          yield* this.timeInitialization(
            initialization,
            "workspace.network.http",
            attempt("workspace.network.http", () => container.interceptAllOutboundHttp(outbound)),
          );
          yield* this.timeInitialization(
            initialization,
            "workspace.network.https",
            attempt("workspace.network.https", () =>
              container.interceptOutboundHttps("*", outbound),
            ),
          );

          if (wasRunning || snapshot) {
            // A Durable Object eviction does not necessarily stop its container.
            // Reuse that live checkout, but never infer readiness for a fresh image.
            this.initialized = true;

            const setup = yield* this.timeInitialization(
              initialization,
              "workspace.setup.read",
              attempt("workspace.setup.read", () =>
                this.ctx.storage.get<WorkspaceSetup>("workspace:setup"),
              ),
            );

            const ready = yield* this.timeInitialization(
              initialization,
              "workspace.restore.probe",
              this.execute(
                "test -f /workspace/ready && test -d /workspace/repo/.git",
                "/workspace",
                120,
                container,
              ).pipe(
                Effect.mapError((error) =>
                  snapshot && !wasRunning
                    ? new OperationError({
                        operation: "workspace.restore",
                        message: `Unable to restore snapshot ${snapshot.id}: ${exceptionDetails(error).message}`,
                        details: null,
                      })
                    : error,
                ),
                Effect.tap((result) =>
                  snapshot && !wasRunning && result.exitCode !== 0
                    ? Effect.fail(
                        new OperationError({
                          operation: "workspace.restore",
                          message:
                            "Snapshot is missing its prepared checkout; refusing a fresh clone",
                          details: { snapshotId: snapshot.id },
                        }),
                      )
                    : Effect.void,
                ),
                Effect.onError(() =>
                  Effect.sync(() => {
                    this.initialized = false;
                  }),
                ),
              ),
            );

            this.prepared =
              ready.exitCode === 0 &&
              ((!wasRunning && Boolean(snapshot)) ||
                setup?.state === "installing" ||
                setup?.state === "ready" ||
                setup?.state === "warning");
          }
        }

        this.initialized = true;

        yield* this.timeInitialization(
          initialization,
          "sandbox.inactivity",
          attempt("sandbox.inactivity", () => container.setInactivityTimeout(300_000)),
        );

        return container;
      }),
    );
  });

  private execute = Effect.fn("Sandbox.execute")(function* (
    this: Sandbox,
    command: string,
    cwd: string,
    timeout = 60,
    initializingContainer?: Container,
    env: Readonly<Record<string, string>> = {},
  ) {
    // Initialization probes must not recursively re-enter container() when a
    // lazy container startup fails.
    const container = initializingContainer ?? (yield* this.container());
    const startedAt = Date.now();

    const context = {
      sandboxId: String(this.ctx.id),
      initializationId: this.initialization?.id,
      executionId: crypto.randomUUID(),
      timeoutSeconds: timeout,
    };

    let exited = false;

    yield* Effect.logInfo({ event: "sandbox_execution", ...context, phase: "started", startedAt });

    return yield* Effect.acquireUseRelease(
      attempt("sandbox.exec", (signal) =>
        container.exec(["python3", "/usr/local/lib/dolly-exec.py", command], {
          cwd,
          signal,
          env: {
            ...env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
            CURL_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
            SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
            NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
          },
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.logInfo({
            event: "sandbox_execution",
            ...context,
            phase: "process_started",
            elapsedMs: Date.now() - startedAt,
          }),
        ),
      ),
      (process) =>
        Effect.all(
          {
            stdout: readBounded(process.stdout, { limit: 32_768 }),
            stderr: readBounded(process.stderr, { limit: 32_768 }),
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
    ).pipe(
      Effect.timeout(`${timeout} seconds`),
      Effect.onExit((exit) =>
        Effect.logInfo({
          event: "sandbox_execution",
          ...context,
          phase: Exit.isSuccess(exit) ? "completed" : "failed",
          elapsedMs: Date.now() - startedAt,
          exitCode: Exit.isSuccess(exit) ? exit.value.exitCode : undefined,
          interrupted: Exit.hasInterrupts(exit),
        }),
      ),
    );
  });

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

  /** Called only by the durable run-end task, never by setup or individual commands. */
  checkpoint(turnId: string) {
    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          const previous = yield* attempt("workspace.snapshot.read", () =>
            this.ctx.storage.get<WorkspaceSnapshot>("snapshot:checkpoint"),
          );

          if (previous?.turnId === turnId) return previous;

          // Saving must never resurrect a stopped container or clone over lost work.
          if (!this.ctx.container?.running) return null;
          const container = yield* this.container();

          if (!this.prepared) return null;

          const setup = yield* attempt("workspace.setup.read", () =>
            this.ctx.storage.get<WorkspaceSetup>("workspace:setup"),
          );

          if (setup?.state === "installing") this.startDependencySetup(container);

          // Setup writes the same filesystem. Join it without making reads or
          // shell commands wait; never snapshot a partially restored archive.
          yield* attempt(
            "workspace.dependencies.wait",
            () => this.dependencySetup ?? Promise.resolve(),
          );
          const started = Date.now();
          yield* Effect.logInfo({
            event: "workspace_checkpoint_started",
            sandboxId: String(this.ctx.id),
            turnId,
          });

          return yield* Effect.gen({ self: this }, function* () {
            const snapshotName = `workspace-${crypto.randomUUID()}`;
            const snapshot = yield* attempt("workspace.checkpoint", async (signal) => {
              while (true) {
                try {
                  return await container.snapshotContainer({ name: snapshotName });
                } catch (error) {
                  if (
                    !exceptionDetails(error).message.includes(
                      "A snapshot is already in progress for this container",
                    )
                  )
                    throw error;

                  await scheduler.wait(1_000);
                  if (signal.aborted) throw signal.reason;
                }
              }
            }).pipe(Effect.timeout("120 seconds"));

            const saved: WorkspaceSnapshot = { id: snapshot.id, turnId, savedAt: Date.now() };
            yield* this.publishSnapshot(saved);
            yield* Effect.logInfo({
              event: "workspace_checkpoint_succeeded",
              sandboxId: String(this.ctx.id),
              turnId,
              size: snapshot.size,
              elapsedMs: Date.now() - started,
            });

            return saved;
          }).pipe(
            Effect.onError((cause) =>
              Effect.gen({ self: this }, function* () {
                const error = redact(Cause.pretty(cause));
                yield* attempt("workspace.snapshot.error", () =>
                  this.ctx.storage.put("snapshot:error", { turnId, error }),
                ).pipe(Effect.ignore);
                yield* Effect.logError({
                  event: "workspace_checkpoint_failed",
                  sandboxId: String(this.ctx.id),
                  turnId,
                  elapsedMs: Date.now() - started,
                  error,
                });
              }),
            ),
          );
        }),
      ),
    );
  }

  private publishSnapshot(snapshot: WorkspaceSnapshot) {
    return attempt("workspace.checkpoint.save", () =>
      this.ctx.storage.transaction(async (tx) => {
        await tx.put("snapshot:checkpoint", snapshot);
        await tx.delete("snapshot:error");
        // Runs under the foreground permit, so no change can land between the
        // container snapshot and this acknowledgement.
        await tx.delete("workspace:unsaved");
      }),
    );
  }

  /** Called under the permit before a repository command or file write may change files. */
  private markUnsaved() {
    return attempt("workspace.unsaved", () =>
      this.ctx.storage.transaction(async (tx) => {
        if (!(await tx.get<number>("workspace:unsaved")))
          await tx.put("workspace:unsaved", Date.now());
      }),
    );
  }

  private recordRestore(workspace: WorkspaceConfig, snapshot: WorkspaceSnapshot | null) {
    return attempt("workspace.restore.record", () =>
      this.ctx.storage.transaction(async (tx) => {
        const unsavedSince = await tx.get<number>("workspace:unsaved");

        if (!unsavedSince) return false;

        const restore: WorkspaceRestore = {
          restoredAt: Date.now(),
          unsavedSince,
          snapshot,
          ref: workspace.ref,
          branch: workspace.branch,
        };

        await tx.put("workspace:restored", restore);
        await tx.delete("workspace:unsaved");

        return true;
      }),
    ).pipe(
      Effect.tap((recorded) =>
        recorded
          ? Effect.logWarning({
              event: "workspace_restored_with_unsaved_changes",
              sandboxId: String(this.ctx.id),
              snapshotId: snapshot?.id ?? null,
            })
          : Effect.void,
      ),
    );
  }

  private installDependencies = Effect.fn("Sandbox.installDependencies")(function* (
    this: Sandbox,
    container: Container,
  ) {
    const started = Date.now();

    const workspace = yield* attempt("workspace.read", () =>
      this.ctx.storage.get<WorkspaceConfig>("workspace"),
    );

    if (!workspace) return undefined;

    const token = crypto.randomUUID();

    const setupOutbound = this.loopback.WorkspaceOutbound({
      props: { ...workspace, dependencyCacheToken: token, sandbox: String(this.ctx.id) },
    });

    const ordinaryOutbound = this.loopback.WorkspaceOutbound({
      props: { ...workspace, sandbox: String(this.ctx.id) },
    });

    return yield* Effect.acquireUseRelease(
      attempt("workspace.cache.enable", () => container.interceptAllOutboundHttp(setupOutbound)),
      () =>
        Effect.gen({ self: this }, function* () {
          const result = yield* this.execute(
            `DOLLY_DEPENDENCY_CACHE_TOKEN=${token} python3 /usr/local/lib/dolly-setup.py --once`,
            "/workspace/repo",
            900,
            container,
          );

          yield* Effect.logInfo({
            event: "workspace_dependencies_completed",
            sandboxId: String(this.ctx.id),
            elapsedMs: Date.now() - started,
            exitCode: result.exitCode,
          });

          return result.exitCode === 0
            ? undefined
            : redact(result.stderr || result.stdout || `Setup exited ${result.exitCode}`).slice(
                -2000,
              );
        }),
      () =>
        attempt("workspace.cache.disable", () =>
          container.interceptAllOutboundHttp(ordinaryOutbound),
        ).pipe(Effect.orDie),
    ).pipe(Effect.catchCause((cause) => Effect.succeed(redact(Cause.pretty(cause)).slice(-2000))));
  });

  private startDependencySetup(container: Container) {
    if (this.dependencySetup) return;

    const controller = new AbortController();
    this.dependencyAbort = controller;

    // No foreground permit: checkout-ready tools must not queue behind installs
    // or cache publication. Retain ownership for cancellation and checkpoints.
    this.dependencySetup = Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const warning = yield* this.installDependencies(container).pipe(
          Effect.catchCause((cause) => Effect.succeed(redact(Cause.pretty(cause)).slice(-2000))),
        );

        yield* this.setupStatus(warning ? "warning" : "ready", warning);
      }),
      { signal: controller.signal },
    ).catch(async (error) => {
      await Effect.runPromise(this.setupStatus("warning", exceptionDetails(error).message));
    });
    this.ctx.waitUntil(this.dependencySetup);
  }

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
      this.prepareSerialized(config).catch(async (error) => {
        await Effect.runPromise(this.setupStatus("failed", exceptionDetails(error).message));
      }),
    );

    return { queued: true };
  }

  async alarm() {
    const config = await this.ctx.storage.get<WorkspaceConfig>("workspace");

    if (config) {
      try {
        await this.prepareSerialized(config);
      } catch (error) {
        await Effect.runPromise(this.setupStatus("failed", exceptionDetails(error).message));
      }
    }
  }

  private prepareWorkspace = Effect.fn("Sandbox.prepareWorkspace")(function* (
    this: Sandbox,
    config: WorkspaceConfig,
  ) {
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

    // Initialize first so a restarted container never uses a stale warm flag.
    const container = yield* this.container();

    const info = {
      repository: config.repository,
      branch: config.branch,
      ref: config.ref ?? "HEAD",
    };

    if (this.prepared) {
      const setup = yield* attempt("workspace.setup.read", () =>
        this.ctx.storage.get<WorkspaceSetup>("workspace:setup"),
      );

      // A live container can outlast its DO. The container-side lock/result
      // joins an existing installer rather than starting a second one.
      if (setup?.state === "installing") this.startDependencySetup(container);

      return {
        ...info,
        setup,
      };
    }

    yield* this.setupStatus("checkout");
    yield* this.checkout(config);
    yield* this.setupStatus("installing");
    this.prepared = true;
    this.startDependencySetup(container);

    return {
      ...info,
      setup: yield* attempt("workspace.setup.read", () =>
        this.ctx.storage.get<WorkspaceSetup>("workspace:setup"),
      ),
    };
  });

  private runWorkspaceOperation<A, E>(operation: Effect.Effect<A, E>) {
    const controller = (this.setupAbort ??= new AbortController());
    this.setupOperations++;

    return Effect.runPromise(operation, { signal: controller.signal }).finally(() => {
      this.setupOperations--;

      if (!this.setupOperations && this.setupAbort === controller) this.setupAbort = undefined;
    });
  }

  private prepareSerialized(config: WorkspaceConfig) {
    return this.runWorkspaceOperation(
      this.permit
        .withPermit(this.prepareWorkspace(config))
        .pipe(
          Effect.onError((cause) =>
            this.setupStatus("failed", redact(Cause.pretty(cause))).pipe(Effect.ignore),
          ),
        ),
    );
  }

  /**
   * Prepare for a repository tool. If a container replacement discarded unsaved
   * changes since the previous tool, the notice is returned exactly once.
   */
  async prepare(config: WorkspaceConfig) {
    const prepared = await this.prepareSerialized(config);

    const restored = await this.ctx.storage.transaction(async (tx) => {
      const restore = await tx.get<WorkspaceRestore>("workspace:restored");

      if (restore) await tx.delete("workspace:restored");

      return restore;
    });

    return { ...prepared, restored: restored ? restoreNotice(restored) : undefined };
  }

  async waitForDependencies() {
    const config = await this.ctx.storage.get<WorkspaceConfig>("workspace");

    if (!config)
      throw new OperationError({
        operation: "workspace.dependencies.wait",
        message: "No repository is configured",
        details: null,
      });

    await this.prepareSerialized(config);
    await this.dependencySetup;

    const setup = await this.ctx.storage.get<WorkspaceSetup>("workspace:setup");

    if (!setup)
      throw new OperationError({
        operation: "workspace.dependencies.wait",
        message: "Workspace setup status is missing",
        details: null,
      });

    return setup;
  }

  /** `env` adds variables such as the agent's git identity; it cannot override the fixed git and TLS settings. */
  run(command: string, env: Readonly<Record<string, string>> = {}) {
    return this.runWorkspaceOperation(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          const workspace = yield* attempt("workspace.read", () =>
            this.ctx.storage.get<WorkspaceConfig>("workspace"),
          );

          if (workspace) {
            yield* this.prepareWorkspace(workspace);
            yield* this.markUnsaved();
          }

          return yield* this.execute(
            command,
            workspace ? "/workspace/repo" : "/workspace",
            60,
            undefined,
            env,
          );
        }),
      ),
    );
  }

  /** The running container's filesystem, with native Linux semantics. */
  private files = Effect.fn("Sandbox.files")(function* (this: Sandbox) {
    const files: FileSystem = new Files(yield* this.container());

    return files;
  });

  /** Run a file operation in the prepared workspace, as shell commands are. */
  private fileOperation<A>(
    operation: (files: FileSystem) => Effect.Effect<A, OperationError>,
    writes = false,
  ) {
    return this.runWorkspaceOperation(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          const workspace = yield* attempt("workspace.read", () =>
            this.ctx.storage.get<WorkspaceConfig>("workspace"),
          );

          if (workspace) yield* this.prepareWorkspace(workspace);

          if (workspace && writes) yield* this.markUnsaved();

          const files = yield* this.files();

          return yield* operation(files).pipe(Effect.timeout("60 seconds"));
        }),
      ),
    );
  }

  /** Read a line window (default: the first 2,000 lines or 50 KiB), noting how to continue. */
  readFile(path: string, range: FileRange = {}) {
    return this.fileOperation((files) =>
      attempt("sandbox.file.open", (signal) => files.readFile(path, { signal })).pipe(
        Effect.flatMap((response) => readWindow(response.body, range)),
      ),
    );
  }

  /** Create or replace a UTF-8 file, creating missing parent directories. */
  writeFile(path: string, content: string) {
    return this.fileOperation((files) => fileResult(writeChange(files, path, content)), true);
  }

  /** Replace an exact, unambiguous string in an existing UTF-8 file. */
  editFile(path: string, edit: Edit) {
    return this.fileOperation((files) => fileResult(editChange(files, path, edit)), true);
  }

  /** Read only the ready active checkout; never start a container just to build a prompt. */
  skills() {
    if (!this.prepared || !this.ctx.container?.running)
      return Promise.resolve({ status: "unavailable" as const });

    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          const container = this.ctx.container;

          if (!this.prepared || !container?.running) return { status: "unavailable" as const };

          const result = yield* this.execute(
            `python3 -I -c ${shellQuote(skillsInventory)} /workspace/repo`,
            "/workspace/repo",
            10,
            container,
          );

          if (result.exitCode !== 0) return { status: "unavailable" as const };

          return { status: "ready" as const, inventory: result.stdout };
        }),
      ),
    );
  }

  /** Deliberately ephemeral: an evicted DO cannot re-authorize an old server. */
  private livePreview(token?: string) {
    const preview = this.preview;

    return preview &&
      !preview.exited &&
      preview.expiresAt > Date.now() &&
      this.ctx.container?.running &&
      (token === undefined || token === preview.token)
      ? preview
      : undefined;
  }

  private async stopPreviewProcess() {
    const preview = this.preview;
    this.preview = undefined; // Revoke before waiting for process cleanup.

    if (!preview || preview.exited) return;

    try {
      preview.process.kill(15);
      await preview.process.exitCode;
    } catch (error) {
      // A stopped/replaced container has already disposed of this process.
      if (this.ctx.container?.running) throw error;
    }
  }

  previewStart(command: string, port: number) {
    Schema.decodeUnknownSync(PreviewPort)(port);

    if (!command.trim() || command.length > 8192) throw new Error("Invalid preview command");

    return Effect.runPromise(
      this.permit.withPermit(
        attempt("preview.start", async () => {
          if (this.livePreview()) throw new Error("A preview is already running; stop it first");
          await this.stopPreviewProcess();
          const container = await Effect.runPromise(this.container());
          // Do not accidentally publish an unrelated service already on this port.
          let occupied = false;

          try {
            const response = await container.getTcpPort(port).fetch("http://localhost/", {
              signal: AbortSignal.timeout(1000),
            });

            await response.body?.cancel();
            occupied = true;
          } catch {
            // Connection refused is expected before the server starts.
          }

          if (occupied) throw new Error("Preview port is already in use; choose another port");
          const workspace = await this.ctx.storage.get("workspace");

          // Restored containers may predate image-provided runtime directories.
          // Keep this outside the checkout and use the current Worker's supervisor.
          const files = new Files(container);
          await files.mkdir(PREVIEW_DIRECTORY, { recursive: true });
          await files.writeFile(PREVIEW_SUPERVISOR, previewSupervisor);

          const process = await container.exec(
            ["python3", PREVIEW_SUPERVISOR, command, String(PREVIEW_TTL_MS / 1000), PREVIEW_LOG],
            {
              cwd: workspace ? "/workspace/repo" : "/workspace",
              stdout: "ignore",
              stderr: "ignore",
              env: {
                NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
                SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
              },
            },
          );

          const preview: RunningPreview = {
            process,
            token: crypto.randomUUID(),
            port,
            expiresAt: Date.now() + PREVIEW_TTL_MS,
            exited: false,
          };

          this.preview = preview;
          void process.exitCode.then(
            () => {
              preview.exited = true;
            },
            () => {
              preview.exited = true;
            },
          );

          try {
            const deadline = Date.now() + 30_000;

            while (!preview.exited && Date.now() < deadline) {
              try {
                const response = await container.getTcpPort(port).fetch("http://localhost/", {
                  signal: AbortSignal.timeout(1000),
                });

                await response.body?.cancel();

                return { port, expiresAt: preview.expiresAt };
              } catch {
                await scheduler.wait(250);
              }
            }

            throw new Error(
              "Dev server did not become ready within 30 seconds; check preview status logs",
            );
          } catch (error) {
            await this.stopPreviewProcess();
            throw error;
          }
        }),
      ),
    );
  }

  async previewStatus() {
    const preview = this.livePreview();
    let logs = "";

    if (this.ctx.container?.running) {
      try {
        const response = await new Files(this.ctx.container).readFile(PREVIEW_LOG, {
          signal: AbortSignal.timeout(5000),
        });

        logs = await Effect.runPromise(
          readBounded(response.body, { limit: 32_768 }).pipe(Effect.timeout("5 seconds")),
        );
      } catch {
        // No log exists before the first preview.
      }
    }

    return {
      running: Boolean(preview),
      port: preview?.port,
      expiresAt: preview?.expiresAt,
      logs: redact(logs),
    };
  }

  previewStop() {
    return Effect.runPromise(
      this.permit.withPermit(
        attempt("preview.stop", async () => {
          await this.stopPreviewProcess();

          return { stopped: true };
        }),
      ),
    );
  }

  previewCapability() {
    const preview = this.livePreview();

    if (!preview) throw new Error("No active preview; use preview start first");

    return { token: preview.token, expiresAt: preview.expiresAt };
  }

  async previewFetch(request: Request, token: string) {
    const preview = this.livePreview(token);

    if (!preview) return new Response("Preview is unavailable or expired", { status: 404 });

    return this.portFetch(request, preview.port);
  }

  /**
   * Serve a brokered Browser Run page from a port in this workspace's running container.
   * Never starts a container: a browser request must not resurrect a workspace.
   */
  async browserFetch(request: Request, port: number) {
    if (!this.ctx.container?.running)
      return new Response("The workspace container is not running", { status: 503 });

    return this.portFetch(request, port);
  }

  private portFetch(request: Request, port: number) {
    const url = new URL(request.url);
    url.protocol = "http:";
    // Use an internal host accepted by dev servers, rather than disabling host checks.
    url.host = "localhost";
    const headers = new Headers(request.headers);
    headers.set("Host", "localhost");

    return this.ctx.container!.getTcpPort(port).fetch(
      new Request(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      }),
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

        const checkpoint = yield* attempt("workspace.snapshot.read", () =>
          this.ctx.storage.get<WorkspaceSnapshot>("snapshot:checkpoint"),
        );

        const checkpointError = yield* attempt("workspace.snapshot.error.read", () =>
          this.ctx.storage.get<{ turnId: string; error: string }>("snapshot:error"),
        );

        if (!container?.running || this.initialization?.state === "running")
          return {
            running: container?.running ?? false,
            setup,
            checkpoint,
            checkpointError,
            initialization: this.initialization,
          };

        return yield* Effect.acquireUseRelease(
          attempt("sandbox.diagnostics", () =>
            container.exec(["sh", "-c", checkoutDiagnosticsScript], { cwd: "/workspace" }),
          ),
          (process) =>
            Effect.all(
              {
                running: Effect.succeed(true),
                setup: Effect.succeed(setup),
                checkpoint: Effect.succeed(checkpoint),
                checkpointError: Effect.succeed(checkpointError),
                initialization: Effect.succeed(this.initialization),
                stdout: readBounded(process.stdout, { limit: 32_768 }).pipe(Effect.map(redact)),
                stderr: readBounded(process.stderr, { limit: 32_768 }).pipe(Effect.map(redact)),
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
    this.dependencyAbort?.abort();
    await this.dependencySetup;

    return Effect.runPromise(
      this.permit.withPermit(
        Effect.gen({ self: this }, function* () {
          yield* attempt("preview.stop", () => this.stopPreviewProcess());

          if (this.ctx.container?.running)
            yield* attempt("workspace.restart", () => this.ctx.container!.destroy());
          this.initialized = false;
          this.prepared = false;
          this.dependencySetup = undefined;
          this.dependencyAbort = undefined;
        }),
      ),
    );
  }
}
