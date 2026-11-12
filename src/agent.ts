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
  private readonly alarmPermit = Semaphore.makeUnsafe(1);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.credentials = new Credentials(ctx.storage);
    this.services = Layer.mergeAll(
      Layer.succeed(Account, this.credentials),
      CodexProtocol.layer,
      GitHub.layer(ctx.storage),
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
        "Run a shell command in this conversation's Linux sandbox, in /workspace. Network is disabled. Output is capped at 32 KiB per stream, time at 60 seconds. Files are ephemeral across container restarts.",
      parameters: obj({ command: str() }),
      replay: "unsafe",
      executionMode: "sequential",
      execute: ({ command }: { command: string }, api) =>
        Effect.runPromise(
          rpc(
            "sandbox.shell",
            async () => await this.env.SANDBOX.getByName(String(api.conversationId)).run(command),
          ).pipe(
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
          rpc(
            "sandbox.readFile",
            async () =>
              await this.env.SANDBOX.getByName(String(api.conversationId)).readFile(
                path.startsWith("/") ? path : `/workspace/${path}`,
              ),
          ).pipe(Effect.map((text) => ({ output: [{ type: "text", text }] }))),
        ),
    } satisfies ToolRegistration;

    const coordination = new Coordination(() => this.harness);
    const githubSchema = Schema.toJsonSchemaDocument(GitHubRequest).schema;

    if (!Predicate.isObject(githubSchema))
      return yield* Effect.die("GitHub tool schema must be an object");

    const githubTool = {
      name: "github",
      description:
        "Operate on explicitly approved GitHub repositories without sandbox credentials. Read UTF-8 files, create pi-hard/* branches, write files with an expected sha, and open pull requests. Never merges or writes the default branch. Mutations are not automatically replayed; inspect GitHub after an interrupted write before trying again.",
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

    const tools = [shell, readFile, githubTool, ...coordination.tools()];

    const extension = defineExtension({
      name: "sandbox",
      tools,
      tasks: coordinationTasks,
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

  startLogin() {
    return Effect.runPromise(Effect.provide(startLogin, this.services));
  }
  pollLogin() {
    return Effect.runPromise(Effect.provide(pollLogin, this.services));
  }
  logout() {
    return Effect.runPromise(Effect.provide(logout, this.services));
  }

  createSession(model?: string) {
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
