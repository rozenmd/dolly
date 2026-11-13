import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  configure,
  createRegistry,
  defineExtension,
  Harness,
  section,
  type ConversationId,
  type ToolRegistration,
  type Wake,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { obj, str } from "@earendil-works/pi-schema";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { Coordination, coordinationTasks, indexSession } from "./coordination";
import {
  ConversationWorkspace,
  WorkspaceInput,
  workspaceConfig,
  WorkspaceRequest,
  shellQuote,
  type WorkspaceConfig,
} from "./workspace";
import { gitRoute, checkedPush } from "./git-transport";
import { WebhookSetup } from "./github-webhook";
import { admitGitHub, githubDelivery, GitHubThreads } from "./github-inbox";
import { GitHub } from "./github";
import { GitHubRequest, GitHubSetup, GitHubReply } from "./github-contracts";
import { ChildRequest, ChildMessage, CodexModel } from "./models";
import { Account, Credentials } from "./credentials";
import { CodexProtocol, startLogin, pollLogin, logout } from "./codex-login";
import { exceptionDetails, redact } from "./diagnostics";
import { attempt, rpc, OperationError } from "./operations";
import type { Env } from "./env";

/** Native Durable Object host. Pi owns durable task scheduling; Effect owns application workflows. */
export class Agent extends DurableObject<Env> {
  private harness!: Harness;
  private readonly credentials: Credentials;
  private readonly services: Layer.Layer<Account | CodexProtocol | GitHub>;
  private readonly githubTask = githubDelivery((event, text) =>
    Effect.flatMap(GitHub, (github) => github.reply(event, text)).pipe(
      Effect.provide(this.services),
    ),
  );
  private readonly alarmPermit = Semaphore.makeUnsafe(1);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.credentials = new Credentials(ctx.storage);
    this.services = Layer.mergeAll(
      Layer.succeed(Account, this.credentials),
      CodexProtocol.layer,
      GitHub.layer(ctx.storage, env.GITHUB_WEBHOOK_URL ?? ""),
    );
    void ctx.blockConcurrencyWhile(() => Effect.runPromise(this.initialize()));
  }

  private initialize = Effect.fn("Agent.initialize")(function* (this: Agent) {
    yield* this.arm({ active: true });
    const models = createModels({ credentials: this.credentials });
    const provider = openaiCodexProvider();
    const oauth = provider.auth.oauth;

    if (!oauth) return yield* Effect.die("Codex provider must support OAuth");
    models.setProvider(
      createProvider({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        models: Object.values(OPENAI_CODEX_MODELS),
        // Load the SSE adapter with the Worker, not in an evictable generation request.
        api: { stream, streamSimple },
        auth: {
          oauth: {
            ...oauth,
            // Request auth needs only the stored token, not Pi's Node-only OAuth flow loader.
            toAuth: async (credential) => ({ apiKey: credential.access }),
            refresh: (credential, signal) =>
              Effect.runPromise(
                Effect.tryPromise({
                  try: () => oauth.refresh(credential, signal),
                  catch: (cause) => {
                    const details = exceptionDetails(cause, [
                      credential.access,
                      credential.refresh,
                    ]);

                    return new OperationError({
                      operation: "codex.refresh",
                      message: details.message,
                      details,
                    });
                  },
                }),
              ),
          },
        },
      }),
    );

    const shell = {
      name: "shell",
      description:
        "Run a shell command in this conversation's Linux checkout (or /workspace if no repository is selected). Git authentication stays outside the container. Only configured network hosts are reachable. Output is capped at 32 KiB per stream and time at 60 seconds. Repository workspaces are checkpointed after commands.",
      parameters: obj({ command: str() }),
      replay: "unsafe",
      executionMode: "sequential",
      execute: ({ command }: { command: string }, api) =>
        Effect.runPromise(
          rpc("sandbox.shell", async () => {
            await this.prepareWorkspace(api.conversationId);

            return this.env.SANDBOX.getByName(String(api.conversationId)).run(command);
          }).pipe(
            Effect.map((result) => ({ output: [{ type: "text", text: JSON.stringify(result) }] })),
          ),
        ),
    } satisfies ToolRegistration;

    const readFile = {
      name: "read_file",
      description:
        "Read a UTF-8 file in this conversation's sandbox, maximum 64 KiB. Relative paths use /workspace.",
      parameters: obj({ path: str() }),
      replay: "safe",
      execute: ({ path }: { path: string }, api) =>
        Effect.runPromise(
          rpc("sandbox.readFile", async () => {
            const workspace = await this.prepareWorkspace(api.conversationId);

            return this.env.SANDBOX.getByName(String(api.conversationId)).readFile(
              path.startsWith("/")
                ? path
                : `${workspace ? "/workspace/repo" : "/workspace"}/${path}`,
            );
          }).pipe(Effect.map((text) => ({ output: [{ type: "text", text }] }))),
        ),
    } satisfies ToolRegistration;

    const coordination = new Coordination(() => this.harness);
    const githubSchema = Schema.toJsonSchemaDocument(GitHubRequest).schema;

    if (!Predicate.isObject(githubSchema))
      return yield* Effect.die("GitHub tool schema must be an object");

    const githubTool = {
      name: "github",
      description:
        "Operate on GitHub repositories accessible to the connected App installations without sandbox credentials. Read UTF-8 files, create pi-hard/* branches, write files with an expected sha, and open pull requests. Never merges or writes the default branch. Mutations are not automatically replayed; inspect GitHub after an interrupted write before trying again.",
      parameters: githubSchema,
      replay: "unsafe",
      executionMode: "sequential",
      execute: (input: typeof GitHubRequest.Type) =>
        Effect.runPromise(
          Schema.decodeUnknownEffect(GitHubRequest)(input).pipe(
            Effect.orDie,
            Effect.flatMap((parsed) => Effect.tryPromise(() => this.githubExecute(parsed))),
            Effect.map((result) => ({
              output: [{ type: "text" as const, text: JSON.stringify(result) }],
            })),
          ),
        ),
    } satisfies ToolRegistration;

    const workspaceSchema = Schema.toJsonSchemaDocument(WorkspaceRequest).schema;

    if (!Predicate.isObject(workspaceSchema))
      return yield* Effect.die("Workspace schema must be an object");

    const workspaceTool = {
      name: "workspace",
      description:
        "Select any GitHub repository available to the App and clone it into this conversation's private Linux workspace. Then use shell to edit files and run tests. Inspect status/diff, commit changes, push this session's branch, and open a PR. A checkout is immutable for the conversation; use a new conversation for another repository. Commits and pushes are not automatically replayed after interruption; inspect state before retrying.",
      parameters: workspaceSchema,
      replay: "unsafe",
      executionMode: "sequential",
      execute: (input: typeof WorkspaceRequest.Type, api) =>
        Effect.runPromise(
          Schema.decodeUnknownEffect(WorkspaceRequest)(input).pipe(
            Effect.orDie,
            Effect.flatMap((parsed) =>
              Effect.tryPromise(() => this.runWorkspace(api.conversationId, parsed)),
            ),
            Effect.map((result) => ({
              output: [{ type: "text" as const, text: JSON.stringify(result) }],
            })),
          ),
        ),
    } satisfies ToolRegistration;

    const tools = [shell, readFile, githubTool, workspaceTool, ...coordination.tools()];

    const extension = defineExtension({
      name: "sandbox",
      tools,
      tasks: [...coordinationTasks, this.githubTask],
      sections: [
        section(
          "preamble",
          () =>
            "You are a coding assistant. Use the Linux sandbox for commands and files. Never claim a command ran unless its tool result confirms it.",
          { tag: false },
        ),
      ],
    });

    const registry = createRegistry();
    registry.install(extension);

    const storage = yield* attempt("pi.storage.open", () =>
      openDurableObjectSqliteStorage(this.ctx.storage),
    );

    this.harness = yield* attempt("pi.open", () =>
      Harness.open(
        storage,
        {
          models,
          registry,
          settings: { extensions: [extension], stream: { transport: "sse", timeoutMs: 120_000 } },
          conversationCreated: async (tx, conversation) => {
            await indexSession(tx, conversation.id);
            await configure(tx, conversation.id, {
              model: { provider: "openai-codex", modelId: this.env.CODEX_MODEL },
              thinkingLevel: "low",
              maxTurns: 20,
              tools,
            });
          },
          onWake: (wake) => {
            void Effect.runPromise(
              this.arm(wake).pipe(
                Effect.tapError((error) =>
                  Effect.logError({
                    event: "alarm_write_failed",
                    operation: error.operation,
                    details: error.details,
                  }),
                ),
              ),
            ).catch(() => this.ctx.abort("Alarm persistence failed"));
          },
          onReport: ({ error, ...report }) => {
            void Effect.runPromise(
              this.credentials.get("openai-codex").pipe(
                Effect.flatMap((credential) => {
                  const value = Option.getOrUndefined(credential);

                  return Effect.logError({
                    event: "agent_failure",
                    ...report,
                    error: exceptionDetails(
                      error,
                      value?.type === "oauth" ? [value.access, value.refresh] : [],
                    ),
                  });
                }),
                Effect.catch((cause) =>
                  Effect.logError({ event: "diagnostics_failed", error: exceptionDetails(cause) }),
                ),
              ),
            );
          },
        },
        BACKGROUND_CONTEXT,
      ),
    );
    void this.harness.closed.then((end) => {
      if (end.kind === "failed") this.ctx.abort("Harness storage failed");
    });
    yield* this.arm(this.harness.wake());
    this.harness.resume();
  });

  private arm = Effect.fn("Agent.arm")(function* (this: Agent, wake: Wake) {
    yield* this.alarmPermit.withPermit(
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis;
        const at = wake.active ? Math.min(now + 60_000, wake.at ?? Infinity) : wake.at;
        yield* at === undefined
          ? attempt("alarm.delete", () => this.ctx.storage.deleteAlarm())
          : attempt("alarm.write", () => this.ctx.storage.setAlarm(at));
      }),
    );
  });

  override alarm() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.arm({ ...this.harness.wake(), active: true });
        this.harness.resume();
        yield* this.arm(this.harness.wake());
      }),
    );
  }

  private githubRun<A>(program: Effect.Effect<A, OperationError, GitHub>) {
    return Effect.runPromise(
      program.pipe(
        Effect.provide(this.services),
        Effect.catchTag("OperationError", (error) =>
          Effect.logError({
            event: "github_failed",
            operation: error.operation,
            error: exceptionDetails(error),
            details: error.details,
          }).pipe(Effect.as({ error: error.message })),
        ),
      ),
    );
  }

  githubStatus() {
    return this.githubRun(Effect.flatMap(GitHub, (github) => github.status));
  }
  githubStart(input: typeof GitHubSetup.Type, origin: string) {
    return this.githubRun(
      Schema.decodeUnknownEffect(GitHubSetup)(input).pipe(
        Effect.orDie,
        Effect.flatMap((parsed) =>
          Effect.flatMap(GitHub, (github) => github.start(parsed, origin)),
        ),
      ),
    );
  }
  githubManifest(state: string) {
    return this.githubRun(Effect.flatMap(GitHub, (github) => github.manifest(state)));
  }
  githubComplete(state: string, code: string) {
    return this.githubRun(Effect.flatMap(GitHub, (github) => github.complete(state, code)));
  }
  githubExecute(input: typeof GitHubRequest.Type): Promise<typeof GitHubReply.Type> {
    return Effect.runPromise(
      Schema.decodeUnknownEffect(GitHubRequest)(input).pipe(
        Effect.orDie,
        Effect.flatMap((parsed) => Effect.flatMap(GitHub, (github) => github.execute(parsed))),
        Effect.provide(this.services),
        Effect.catchTag("OperationError", (error) =>
          Effect.logError({
            event: "github_failed",
            operation: error.operation,
            error: exceptionDetails(error),
            details: error.details,
          }).pipe(
            Effect.as({ ok: false as const, code: "provider_error", message: error.message }),
          ),
        ),
      ),
    );
  }

  githubConfigureWebhook(input: typeof WebhookSetup.Type) {
    return this.githubRun(Effect.flatMap(GitHub, (github) => github.configureWebhook(input)));
  }

  async githubThreads() {
    const state = await this.harness.snapshot(GitHubThreads, BACKGROUND_CONTEXT);

    return Promise.all(
      Object.entries(state?.threads ?? {}).map(async ([thread, value]) => ({
        thread,
        id: String(value.id),
        deliveries: await Promise.all(
          Object.entries(value.events).map(async ([commentId, taskId]) => {
            const task = await this.harness.getTask(taskId, BACKGROUND_CONTEXT);

            return {
              commentId,
              taskId: String(taskId),
              status: task?.state.status ?? "missing",
              outcome: task?.state.status === "terminal" ? task.state.outcome.status : null,
            };
          }),
        ),
      })),
    );
  }

  githubWebhook(body: ArrayBuffer, signature: string, event: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const verified = yield* Effect.flatMap(GitHub, (github) =>
          github.receiveWebhook(body, signature, event),
        );

        if (verified.status !== 202) return verified;

        if (Option.isNone(yield* this.credentials.get("openai-codex")))
          return { status: 503 as const };
        yield* this.arm({ active: true });

        return yield* admitGitHub(this.harness, this.githubTask, verified.event);
      }).pipe(
        Effect.provide(this.services),
        Effect.catchTag("OperationError", (error) =>
          Effect.logError({
            event: "github_ingress_failed",
            error: exceptionDetails(error),
            details: error.details,
          }).pipe(Effect.as({ status: 503 as const })),
        ),
      ),
    );
  }

  private async prepareWorkspace(id: ConversationId) {
    const state = await this.harness.snapshot(ConversationWorkspace, id, BACKGROUND_CONTEXT);

    if (!state?.config) return null;
    await this.env.SANDBOX.getByName(String(id)).prepare(state.config);

    return state.config;
  }

  private async runWorkspace(id: ConversationId, input: typeof WorkspaceRequest.Type) {
    if (input.action === "checkout") {
      await Effect.runPromise(
        Effect.flatMap(GitHub, (github) => github.authorize(input.repository, false)).pipe(
          Effect.provide(this.services),
        ),
      );
      await this.harness.commit(async (tx) => {
        const state = await tx.doc(ConversationWorkspace, id);

        if (state.config) {
          if (
            state.config.repository !== input.repository ||
            (input.ref && state.config.ref !== input.ref)
          )
            throw new Error("This conversation already owns a different workspace");
        } else state.config = workspaceConfig(input, String(id));
      }, BACKGROUND_CONTEXT);
    }

    const workspace = await this.prepareWorkspace(id);

    if (!workspace) return { error: "Select a repository using workspace checkout first" };
    const sandbox = this.env.SANDBOX.getByName(String(id));

    switch (input.action) {
      case "checkout":
        return workspace;
      case "status":
        return sandbox.run("git status --short --branch");
      case "diff":
        return sandbox.run("git diff --binary HEAD");
      case "commit":
        return sandbox.run(`git add -A && git commit -m ${shellQuote(input.message)}`);
      case "push":
        return sandbox.run(`git push origin HEAD:${shellQuote(`refs/heads/${workspace.branch}`)}`);
      case "open_pull_request": {
        const base = await Effect.runPromise(
          Effect.flatMap(GitHub, (github) => github.authorize(workspace.repository, false)).pipe(
            Effect.map((result) => result.defaultBranch),
            Effect.provide(this.services),
          ),
        );

        return this.githubExecute({
          operation: {
            action: "open_pull_request",
            repository: workspace.repository,
            branch: workspace.branch,
            base,
            title: input.title,
            body: input.body,
          },
        });
      }
    }
  }

  async workspace(id: string, input: typeof WorkspaceRequest.Type) {
    const conversation = await Effect.runPromise(this.conversation(id));

    if (Option.isNone(conversation)) return { error: "Session not found" };

    return this.runWorkspace(conversation.value.id, input);
  }

  gitTransport(request: Request, workspace: WorkspaceConfig) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const route = gitRoute(request, workspace.repository);

        if (!route) return new Response("Git route denied", { status: 403 });

        const authorized = yield* Effect.flatMap(GitHub, (github) =>
          github.authorize(workspace.repository, route.write),
        );

        if (route.write && workspace.branch === authorized.defaultBranch)
          return new Response("Default branch writes are forbidden", { status: 403 });

        const body =
          request.method === "POST" && route.write
            ? yield* attempt("git.push.validate", () => checkedPush(request.body, workspace.branch))
            : request.body;

        if (request.method === "POST" && route.write && !body)
          return new Response("Only non-deleting updates to the session branch are allowed", {
            status: 403,
          });
        const headers = new Headers();

        for (const name of ["Content-Type", "Accept", "Git-Protocol", "Content-Encoding"]) {
          const value = request.headers.get(name);

          if (value) headers.set(name, value);
        }

        headers.set("Authorization", `Basic ${btoa(`x-access-token:${authorized.token}`)}`);

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`https://github.com${route.path}`, {
              method: request.method,
              body,
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(120_000),
            }),
          catch: (cause) =>
            new OperationError({
              operation: "git.transport",
              message: "Git transport failed",
              details: exceptionDetails(cause, [
                authorized.token,
                headers.get("Authorization") ?? "",
              ]),
            }),
        }).pipe(
          Effect.ensuring(
            attempt("git.request.cancel", async () => {
              if (body && !body.locked) await body.cancel();
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning({
                  event: "git_request_cleanup_failed",
                  error: exceptionDetails(error),
                }),
              ),
            ),
          ),
        );

        if (response.status >= 300 && response.status < 400) {
          yield* attempt("git.redirect.cancel", async () => {
            await response.body?.cancel();
          });

          return new Response("Git redirects are forbidden", { status: 502 });
        }

        return response;
      }).pipe(
        Effect.provide(this.services),
        Effect.catchTag("OperationError", (error) =>
          Effect.logError({
            event: "git_transport_failed",
            error: exceptionDetails(error),
            details: error.details,
          }).pipe(
            Effect.as(new Response("Git transport failed; check Worker logs", { status: 502 })),
          ),
        ),
      ),
    );
  }

  startLogin() {
    return Effect.runPromise(Effect.provide(startLogin, this.services));
  }
  pollLogin() {
    return Effect.runPromise(Effect.provide(pollLogin, this.services));
  }
  logout() {
    return Effect.runPromise(Effect.provide(logout, this.services));
  }

  createSession(model?: string, workspace?: typeof WorkspaceInput.Type) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        if (Option.isNone(yield* this.credentials.get("openai-codex")))
          return { error: "Connect your Codex subscription first" };

        const modelId = yield* Schema.decodeUnknownEffect(CodexModel)(
          model ?? this.env.CODEX_MODEL,
        ).pipe(
          Effect.mapError(
            () =>
              new OperationError({
                operation: "session.model",
                message: "Unknown Codex model",
                details: "Select a model from the pinned Pi Codex catalog",
              }),
          ),
        );

        const conversation = yield* attempt("pi.conversation.create", () =>
          this.harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: { model: { provider: "openai-codex", modelId } },
            },
            BACKGROUND_CONTEXT,
          ),
        );

        if (workspace)
          yield* attempt("workspace.configure", () =>
            this.harness.commit(async (tx) => {
              const state = await tx.doc(ConversationWorkspace, conversation.id);
              state.config = workspaceConfig(workspace, String(conversation.id));
            }, BACKGROUND_CONTEXT),
          );

        const id = crypto.randomUUID();
        yield* attempt("session.write", () =>
          this.ctx.storage.put(`session:${id}`, conversation.id),
        );

        return { id, model: modelId };
      }),
    );
  }

  private conversation = Effect.fn("Agent.conversation")(function* (this: Agent, id: string) {
    const conversationId = yield* attempt("session.read", () =>
      this.ctx.storage.get<ConversationId>(`session:${id}`),
    );

    const resolved = conversationId ?? (yield* new Coordination(() => this.harness).resolve(id));

    if (resolved === undefined) return Option.none();

    return Option.fromUndefinedOr(
      yield* attempt("pi.conversation.read", () =>
        this.harness.conversation(resolved, BACKGROUND_CONTEXT),
      ),
    );
  });

  prompt(id: string, content: string, requestId: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const conversation = yield* this.conversation(id);

        if (Option.isNone(conversation)) return undefined;

        if (Option.isNone(yield* this.credentials.get("openai-codex")))
          return { error: "Connect your Codex subscription first" };
        yield* this.arm({ active: true });

        const submission = yield* attempt("pi.submit", () =>
          conversation.value.submit(
            { type: "input", content, requestId, whenBusy: "followUp" },
            BACKGROUND_CONTEXT,
          ),
        );

        return { submissionId: submission.id };
      }),
    );
  }

  transcript(id: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const conversation = yield* this.conversation(id);

        if (Option.isNone(conversation)) return undefined;

        return yield* Effect.acquireUseRelease(
          attempt("pi.watch", () => conversation.value.watch(BACKGROUND_CONTEXT)),
          (view) =>
            this.credentials.get("openai-codex").pipe(
              Effect.map((credential) => {
                const value = Option.getOrUndefined(credential);

                const secrets = value?.type === "oauth" ? [value.access, value.refresh] : [];

                return JSON.stringify(view.value, (key, item) => {
                  if (!Predicate.isString(item)) return item;

                  // Preserve field-based redaction for credentials other than the current grant.
                  if (
                    /^(?:access_token|refresh_token|id_token|code_verifier|device_auth_id|user_code|authorization_code)$/i.test(
                      key,
                    )
                  )
                    return "[redacted]";

                  return redact(item, secrets);
                });
              }),
            ),
          (view) => attempt("pi.watch.stop", () => view.stop()).pipe(Effect.orDie),
        );
      }),
    );
  }

  children(id: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parent = yield* this.conversation(id);

        if (Option.isNone(parent)) return undefined;

        return yield* new Coordination(() => this.harness).list(parent.value.id);
      }),
    );
  }

  spawnChild(
    id: string,
    input: typeof ChildRequest.Type,
  ): Promise<{ id: string; model: string; taskId: string } | { error: string } | undefined> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parsed = yield* Schema.decodeUnknownEffect(ChildRequest)(input);
        const parent = yield* this.conversation(id);

        if (Option.isNone(parent)) return undefined;

        if (Option.isNone(yield* this.credentials.get("openai-codex")))
          return { error: "Connect your Codex subscription first" };
        yield* this.arm({ active: true });

        return yield* new Coordination(() => this.harness).spawn(parent.value.id, parsed);
      }),
    );
  }

  sendChild(
    id: string,
    childId: string,
    input: typeof ChildMessage.Type,
  ): Promise<{ taskId: string } | { error: string } | undefined> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parsed = yield* Schema.decodeUnknownEffect(ChildMessage)(input);
        const parent = yield* this.conversation(id);

        if (Option.isNone(parent)) return undefined;

        if (Option.isNone(yield* this.credentials.get("openai-codex")))
          return { error: "Connect your Codex subscription first" };
        yield* this.arm({ active: true });

        return yield* new Coordination(() => this.harness).send(parent.value.id, childId, parsed);
      }),
    );
  }

  childTask(id: string, taskId: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const parent = yield* this.conversation(id);

        if (Option.isNone(parent)) return undefined;

        const receipt = yield* new Coordination(() => this.harness).receipt(
          parent.value.id,
          taskId,
          false,
        );

        const credential = Option.getOrUndefined(yield* this.credentials.get("openai-codex"));
        const secrets = credential?.type === "oauth" ? [credential.access, credential.refresh] : [];

        return "result" in receipt && receipt.result?.status === "answered"
          ? {
              ...receipt,
              result: { ...receipt.result, text: redact(receipt.result.text, secrets) },
            }
          : receipt;
      }),
    );
  }

  abort(id: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const conversation = yield* this.conversation(id);

        if (Option.isNone(conversation)) return undefined;

        yield* attempt("pi.abort", () =>
          conversation.value.abort(BACKGROUND_CONTEXT, { background: true }),
        );

        return { state: "aborted" };
      }),
    );
  }
}
