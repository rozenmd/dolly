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
  GenerationTask,
  hook,
  Harness,
  section,
  type ConversationId,
  type ConversationView,
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
  activeWorkspace,
  selectRepository,
  workspacePrompt,
  WorkspaceRequest,
  shellQuote,
  type WorkspaceConfig,
} from "./workspace";
import { gitRoute, checkedPush } from "./git-transport";
import { WebhookSetup } from "./github-webhook";
import { admitGitHub, githubDelivery, GitHubThreads } from "./github-inbox";
import { GitHub } from "./github";
import { GitHubRequest, GitHubAccounts, GitHubSetup, GitHubReply } from "./github-contracts";
import {
  ChildRequest,
  ChildMessage,
  SessionModel,
  modelProvider,
  DEFAULT_CLAUDE_MODEL,
} from "./models";
import {
  claudeProvider,
  anthropicStatus,
  saveAnthropic,
  testAnthropic,
  AnthropicSetup,
  AnthropicProbe,
} from "./anthropic";
import { Account, Credentials } from "./credentials";
import { CodexProtocol, startLogin, pollLogin, logout } from "./codex-login";
import { GitHubAuth } from "./github-auth";
import { exceptionDetails, redact } from "./diagnostics";
import { attempt, rpc, OperationError } from "./operations";
import type { Env } from "./env";
import { resolveImages, storeImages, type PromptImage } from "./images";

/** Durable Object host. Pi owns durable task scheduling; Effect owns application workflows. */
export class Agent extends DurableObject<Env> {
  private harness!: Harness;
  private readonly credentials: Credentials;
  private readonly services: Layer.Layer<Account | CodexProtocol | GitHub | GitHubAuth>;
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
      GitHub.layer(ctx.storage),
      GitHubAuth.layer(ctx.storage),
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
    models.setProvider(claudeProvider());

    const shell = {
      name: "shell",
      description:
        "Run a shell command in the active repository's isolated Linux checkout (or /workspace if none). Use workspace checkout to switch repositories in this same conversation; other checkouts and changes are preserved. Git credentials stay outside the container. Only configured network hosts are reachable. Output is capped at 32 KiB per stream and time at 60 seconds. Repository checkouts are checkpointed after commands.",
      parameters: obj({ command: str() }),
      replay: "unsafe",
      executionMode: "sequential",
      execute: ({ command }: { command: string }, api) =>
        Effect.runPromise(
          rpc("sandbox.shell", async () => {
            const workspace = await this.prepareWorkspace(api.conversationId);

            return this.env.SANDBOX.getByName(
              workspace?.sandboxId ?? String(api.conversationId),
            ).run(command);
          }).pipe(
            Effect.map((result) => ({ output: [{ type: "text", text: JSON.stringify(result) }] })),
          ),
        ),
    } satisfies ToolRegistration;

    const readFile = {
      name: "read_file",
      description:
        "Read a UTF-8 file in the active repository's sandbox, maximum 64 KiB. Relative paths use /workspace/repo, or /workspace when no repo is selected. Use workspace attach to work in another repo.",
      parameters: obj({ path: str() }),
      replay: "safe",
      execute: ({ path }: { path: string }, api) =>
        Effect.runPromise(
          rpc("sandbox.readFile", async () => {
            const workspace = await this.prepareWorkspace(api.conversationId);

            return this.env.SANDBOX.getByName(
              workspace?.sandboxId ?? String(api.conversationId),
            ).readFile(
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
        "Operate on GitHub repositories accessible to the connected App installations without sandbox credentials. Read UTF-8 files, create dolly/* branches, write files with an expected sha, and open pull requests. Never merges or writes the default branch. Mutations are not automatically replayed; inspect GitHub after an interrupted write before trying again.",
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
        "Work across repositories in this conversation. When the user mentions another repository, use action repositories to resolve its enrolled name, then action attach with owner/repo or a unique enrolled short name. Ask if a name is ambiguous. Attach creates or activates an isolated checkout without replacing the optional primary repository or losing changes. Shell, read_file, status, diff, commit, push and open_pull_request use the active repository. Each repository has its own sandbox; files are not shared between checkouts. Switch back with attach or checkout. Checkout sets a primary only if none exists. Never require a new conversation just to use another repo. Mutations are not automatically replayed; inspect state after interruption.",
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
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async ({ messages }) => ({
            messages: await resolveImages(this.env.SCREENSHOTS, messages),
          }),
        }),
      ],
      sections: [
        section(
          "preamble",
          () =>
            "You are a coding assistant. Use the Linux sandbox for commands and files. Never claim a command ran unless its tool result confirms it.",
          { tag: false },
        ),
        section("workspace-context", async ({ read, conversationId }, context) =>
          workspacePrompt(await read.snapshot(ConversationWorkspace, conversationId, context)),
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
              this.credentials.secrets.pipe(
                Effect.flatMap((secrets) => {
                  return Effect.logError({
                    event: "agent_failure",
                    ...report,
                    error: exceptionDetails(error, secrets),
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

  private githubRun<A>(program: Effect.Effect<A, OperationError, GitHub | GitHubAuth>) {
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

  githubAccounts() {
    return this.githubRun(
      Effect.flatMap(GitHub, (github) =>
        github.accounts.pipe(Effect.map((accounts) => ({ accounts }))),
      ),
    );
  }
  githubConfigureAccounts(input: typeof GitHubAccounts.Type) {
    return this.githubRun(
      Schema.decodeUnknownEffect(GitHubAccounts)(input).pipe(
        Effect.orDie,
        Effect.flatMap((parsed) =>
          Effect.flatMap(GitHub, (github) => github.configureAccounts(parsed)),
        ),
      ),
    );
  }
  githubStatus() {
    return this.githubRun(Effect.flatMap(GitHub, (github) => github.status));
  }

  githubRepositories(available: boolean) {
    return this.githubRun(
      Effect.flatMap(GitHub, (github) =>
        Effect.map(
          available ? github.availableRepositories : github.enrolledRepositories,
          (repositories) => ({ repositories }),
        ),
      ),
    );
  }

  githubEnrollRepository(repository: string, remove: boolean) {
    if (remove)
      return this.githubRun(
        Effect.flatMap(GitHub, (github) => github.removeRepository(repository)),
      );

    return this.githubRun(Effect.flatMap(GitHub, (github) => github.enrollRepository(repository)));
  }
  /** What the browser needs before sign-in: whether a GitHub App exists and has an owner. */
  authState() {
    return this.githubRun(
      Effect.gen(function* () {
        const github = yield* Effect.flatMap(GitHub, (value) => value.status);
        const owner = yield* Effect.flatMap(GitHubAuth, (auth) => auth.owner);

        return { github, ownerClaimed: Option.isSome(owner) };
      }),
    );
  }
  authOwnerClaimed() {
    return Effect.runPromise(
      Effect.flatMap(GitHubAuth, (auth) => auth.owner).pipe(
        Effect.map(Option.isSome),
        Effect.provide(this.services),
      ),
    );
  }
  authStart() {
    return this.githubRun(
      Effect.flatMap(GitHub, (github) => github.clientId).pipe(
        Effect.flatMap((clientId) => Effect.flatMap(GitHubAuth, (auth) => auth.start(clientId))),
      ),
    );
  }
  authPoll(flow: string) {
    return this.githubRun(
      Effect.flatMap(GitHub, (github) => github.clientId).pipe(
        Effect.flatMap((clientId) =>
          Effect.flatMap(GitHubAuth, (auth) => auth.poll(clientId, flow)),
        ),
      ),
    );
  }
  authSession(token: string) {
    return Effect.runPromise(
      Effect.flatMap(GitHubAuth, (auth) => auth.session(token)).pipe(
        Effect.provide(this.services),
        Effect.catchTag("OperationError", (error) =>
          Effect.logError({
            event: "auth_session_failed",
            operation: error.operation,
            error: exceptionDetails(error),
          }).pipe(Effect.as(null)),
        ),
      ),
    );
  }
  authSignOut(token: string) {
    return this.githubRun(Effect.flatMap(GitHubAuth, (auth) => auth.signOut(token)));
  }
  githubConfigureIngress(url: string) {
    return this.githubRun(Effect.flatMap(GitHub, (github) => github.configureIngress(url)));
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
    const active = activeWorkspace(state, String(id));

    if (!active) return null;
    await this.env.SANDBOX.getByName(active.sandboxId).prepare(active.config);

    return { ...active.config, sandboxId: active.sandboxId };
  }

  private async runWorkspace(id: ConversationId, input: typeof WorkspaceRequest.Type) {
    if (input.action === "repositories") {
      const state = await this.harness.snapshot(ConversationWorkspace, id, BACKGROUND_CONTEXT);
      const enrolled = await this.githubRepositories(false);

      return {
        ...enrolled,
        primary: state?.config?.repository ?? null,
        active: state?.activeRepository ?? state?.config?.repository ?? null,
        attached: state?.attached ?? [],
      };
    }

    if (input.action === "checkout" || input.action === "attach") {
      const repository = await Effect.runPromise(
        Effect.flatMap(GitHub, (github) =>
          github
            .resolveRepository(input.repository)
            .pipe(Effect.tap((name) => github.authorize(name, false))),
        ).pipe(Effect.provide(this.services)),
      );

      await this.harness.commit(async (tx) => {
        const state = await tx.doc(ConversationWorkspace, id);

        selectRepository(state, { ...input, repository }, String(id));
      }, BACKGROUND_CONTEXT);
    }

    const workspace = await this.prepareWorkspace(id);

    if (!workspace) return { error: "Select a repository using workspace checkout first" };
    const sandbox = this.env.SANDBOX.getByName(workspace.sandboxId);

    switch (input.action) {
      case "checkout":
      case "attach":
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

  anthropicStatus() {
    return Effect.runPromise(anthropicStatus(this.credentials));
  }

  anthropicSave(input: typeof AnthropicSetup.Type) {
    return Effect.runPromise(saveAnthropic(this.credentials, input));
  }

  anthropicTest(input: typeof AnthropicProbe.Type) {
    return Effect.runPromise(testAnthropic(this.credentials, input));
  }

  anthropicLogout() {
    return Effect.runPromise(
      this.credentials
        .locked(this.credentials.remove("anthropic"))
        .pipe(Effect.as({ connected: false })),
    );
  }

  createSession(model?: string, workspace?: typeof WorkspaceInput.Type) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const codex = yield* this.credentials.get("openai-codex");
        const claude = yield* this.credentials.get("anthropic");

        const defaultModel =
          Option.isNone(codex) && Option.isSome(claude)
            ? DEFAULT_CLAUDE_MODEL
            : this.env.CODEX_MODEL;

        const modelId = yield* Schema.decodeUnknownEffect(SessionModel)(model ?? defaultModel).pipe(
          Effect.mapError(
            () =>
              new OperationError({
                operation: "session.model",
                message: "Unknown model",
                details: "Select a model from the pinned Pi Codex or Anthropic catalog",
              }),
          ),
        );

        const provider = modelProvider(modelId);

        if (Option.isNone(provider === "anthropic" ? claude : codex))
          return {
            error:
              provider === "anthropic"
                ? "Connect your Claude subscription first"
                : "Connect your Codex subscription first",
          };

        const conversation = yield* attempt("pi.conversation.create", () =>
          this.harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: { model: { provider, modelId } },
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

  prompt(id: string, content: string, requestId: string, images: readonly PromptImage[] = []) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const conversation = yield* this.conversation(id);

        if (Option.isNone(conversation)) return undefined;

        const agent = yield* attempt("session.model", () =>
          conversation.value.agent(BACKGROUND_CONTEXT),
        );

        const provider = agent.model?.provider ?? "openai-codex";

        if (Option.isNone(yield* this.credentials.get(provider)))
          return {
            error:
              provider === "anthropic"
                ? "Connect your Claude subscription first"
                : "Connect your Codex subscription first",
          };
        yield* this.arm({ active: true });

        const imageBlocks = yield* attempt("screenshots.store", () =>
          storeImages(this.env.SCREENSHOTS, images),
        );

        const submission = yield* attempt("pi.submit", () =>
          conversation.value.submit(
            {
              type: "input",
              // Persist only R2 references; beforeRequest hydrates image bytes transiently.
              content: imageBlocks.length
                ? [{ type: "text" as const, text: content }, ...imageBlocks]
                : content,
              requestId,
              whenBusy: "followUp",
            },
            BACKGROUND_CONTEXT,
          ),
        );

        return { submissionId: submission.id };
      }),
    );
  }

  private serializeTranscript(value: ConversationView) {
    return this.credentials.secrets.pipe(
      Effect.map((secrets) => {
        return JSON.stringify(value, (key, item) => {
          if (!Predicate.isString(item)) return item;

          if (
            /^(?:access_token|refresh_token|id_token|code_verifier|device_auth_id|user_code|authorization_code)$/i.test(
              key,
            )
          )
            return "[redacted]";

          return redact(item, secrets);
        });
      }),
    );
  }

  /** Internal fetch: the Worker authenticates and checks Origin before forwarding here. */
  override async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket upgrade", { status: 426 });

    const id = new URL(request.url).searchParams.get("session") ?? "";
    const conversation = await Effect.runPromise(this.conversation(id));

    if (Option.isNone(conversation)) return new Response("Session not found", { status: 404 });

    const view = await conversation.value.watch(BACKGROUND_CONTEXT);
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.ctx.waitUntil(view.stop());
    };

    const fail = () => {
      if (stopped) return;
      stop();
      server.close(1011, "Session stream ended");
    };

    const send = async (value: ConversationView) => {
      const text = await Effect.runPromise(this.serializeTranscript(value));

      if (!stopped) server.send(text);
    };

    server.addEventListener("close", stop);
    server.addEventListener("error", stop);
    void view.closed.then(fail);

    try {
      await send(view.value);
      view.start(async (change) => {
        if (change.kind !== "value") {
          fail();

          return;
        }

        try {
          await send(change.value);
        } catch {
          fail();
        }
      });
    } catch (error) {
      fail();
      throw error;
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  transcript(id: string) {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const conversation = yield* this.conversation(id);

        if (Option.isNone(conversation)) return undefined;

        return yield* Effect.acquireUseRelease(
          attempt("pi.watch", () => conversation.value.watch(BACKGROUND_CONTEXT)),
          (view) => this.serializeTranscript(view.value),
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

        const agent = yield* attempt("parent.model", () => parent.value.agent(BACKGROUND_CONTEXT));

        const provider = modelProvider(
          parsed.model ?? agent.model?.modelId ?? this.env.CODEX_MODEL,
        );

        if (Option.isNone(yield* this.credentials.get(provider)))
          return {
            error:
              provider === "anthropic"
                ? "Connect your Claude subscription first"
                : "Connect your Codex subscription first",
          };
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

        const coordination = new Coordination(() => this.harness);
        const children = yield* coordination.list(parent.value.id);
        const child = children.children.find((candidate) => candidate.id === childId);

        if (!child) return { error: "Not a direct child of this session" };
        const provider = modelProvider(child.model);

        if (Option.isNone(yield* this.credentials.get(provider)))
          return {
            error:
              provider === "anthropic"
                ? "Connect your Claude subscription first"
                : "Connect your Codex subscription first",
          };
        yield* this.arm({ active: true });

        return yield* coordination.send(parent.value.id, childId, parsed);
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

        const secrets = yield* this.credentials.secrets;

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
