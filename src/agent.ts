import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { configure, createRegistry, defineExtension, Harness, section, type ConversationId, type ToolRegistration, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { obj, str } from "@earendil-works/pi-schema";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { Account, Credentials } from "./credentials";
import { CodexProtocol, startLogin, pollLogin, logout } from "./codex-login";
import { exceptionDetails, redact } from "./diagnostics";
import { attempt, rpc, OperationError } from "./operations";
import type { Env } from "./env";

/** Native Durable Object host. Pi owns durable task scheduling; Effect owns application workflows. */
export class Agent extends DurableObject<Env> {
  private harness!: Harness;
  private readonly credentials: Credentials;
  private readonly services: Layer.Layer<Account | CodexProtocol>;
  private readonly alarmPermit = Semaphore.makeUnsafe(1);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.credentials = new Credentials(ctx.storage);
    this.services = Layer.mergeAll(Layer.succeed(Account, this.credentials), CodexProtocol.layer);
    void ctx.blockConcurrencyWhile(() => Effect.runPromise(this.initialize()));
  }

  private initialize = Effect.fn("Agent.initialize")(function*(this: Agent) {
    yield* this.arm({ active: true });
    const models = createModels({ credentials: this.credentials });
    const provider = openaiCodexProvider();
    const oauth = provider.auth.oauth;
    if (!oauth) return yield* Effect.die("Codex provider must support OAuth");
    models.setProvider({ ...provider, auth: { oauth: {
      ...oauth,
      refresh: (credential, signal) => Effect.runPromise(Effect.tryPromise({
        try: () => oauth.refresh(credential, signal),
        catch: (cause) => {
          const details = exceptionDetails(cause, [credential.access, credential.refresh]);
          return new OperationError({ operation: "codex.refresh", message: details.message, details });
        },
      })),
    } } });
    const shell = {
      name: "shell",
      description: "Run a shell command in this conversation's Linux sandbox, in /workspace. Network is disabled. Output is capped at 32 KiB per stream, time at 60 seconds. Files are ephemeral across container restarts.",
      parameters: obj({ command: str() }),
      replay: "unsafe",
      executionMode: "sequential",
      execute: ({ command }: { command: string }, api) => Effect.runPromise(
        rpc("sandbox.shell", async () => await this.env.SANDBOX.getByName(String(api.conversationId)).run(command)).pipe(
          Effect.map((result) => ({ output: [{ type: "text", text: JSON.stringify(result) }] })),
        ),
      ),
    } satisfies ToolRegistration;
    const readFile = {
      name: "read_file",
      description: "Read a UTF-8 file in this conversation's sandbox, maximum 64 KiB. Relative paths use /workspace.",
      parameters: obj({ path: str() }),
      replay: "safe",
      execute: ({ path }: { path: string }, api) => Effect.runPromise(
        rpc("sandbox.readFile", async () => await this.env.SANDBOX.getByName(String(api.conversationId)).readFile(path.startsWith("/") ? path : `/workspace/${path}`)).pipe(
          Effect.map((text) => ({ output: [{ type: "text", text }] })),
        ),
      ),
    } satisfies ToolRegistration;
    const extension = defineExtension({
      name: "sandbox",
      tools: [shell, readFile],
      sections: [section("preamble", () => "You are a coding assistant. Use the Linux sandbox for commands and files. Never claim a command ran unless its tool result confirms it.", { tag: false })],
    });
    const registry = createRegistry();
    registry.install(extension);
    const storage = yield* attempt("pi.storage.open", () => openDurableObjectSqliteStorage(this.ctx.storage));
    this.harness = yield* attempt("pi.open", () => Harness.open(storage, {
      models,
      registry,
      settings: { extensions: [extension], stream: { transport: "sse", timeoutMs: 120_000 } },
      conversationCreated: (tx, conversation) => configure(tx, conversation.id, {
        model: { provider: "openai-codex", modelId: this.env.CODEX_MODEL },
        thinkingLevel: "low",
        maxTurns: 20,
        tools: [shell, readFile],
      }),
      onWake: (wake) => {
        void Effect.runPromise(this.arm(wake).pipe(
          Effect.tapError((error) => Effect.logError({ event: "alarm_write_failed", operation: error.operation, details: error.details })),
        )).catch(() => this.ctx.abort("Alarm persistence failed"));
      },
      onReport: ({ error, ...report }) => {
        void Effect.runPromise(this.credentials.get("openai-codex").pipe(
          Effect.flatMap((credential) => {
            const value = Option.getOrUndefined(credential);
            return Effect.logError({ event: "agent_failure", ...report, error: exceptionDetails(error, value?.type === "oauth" ? [value.access, value.refresh] : []) });
          }),
          Effect.catch((cause) => Effect.logError({ event: "diagnostics_failed", error: exceptionDetails(cause) })),
        ));
      },
    }, BACKGROUND_CONTEXT));
    void this.harness.closed.then((end) => {
      if (end.kind === "failed") this.ctx.abort("Harness storage failed");
    });
    yield* this.arm(this.harness.wake());
    this.harness.resume();
  });

  private arm = Effect.fn("Agent.arm")(function*(this: Agent, wake: Wake) {
    yield* this.alarmPermit.withPermit(Effect.gen({ self: this }, function*() {
      const now = yield* Clock.currentTimeMillis;
      const at = wake.active ? Math.min(now + 60_000, wake.at ?? Infinity) : wake.at;
      yield* at === undefined
        ? attempt("alarm.delete", () => this.ctx.storage.deleteAlarm())
        : attempt("alarm.write", () => this.ctx.storage.setAlarm(at));
    }));
  });

  override alarm() {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      yield* this.arm({ ...this.harness.wake(), active: true });
      this.harness.resume();
      yield* this.arm(this.harness.wake());
    }));
  }

  startLogin() { return Effect.runPromise(Effect.provide(startLogin, this.services)); }
  pollLogin() { return Effect.runPromise(Effect.provide(pollLogin, this.services)); }
  logout() { return Effect.runPromise(Effect.provide(logout, this.services)); }

  createSession() {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      if (Option.isNone(yield* this.credentials.get("openai-codex"))) return { error: "Connect your Codex subscription first" };
      const conversation = yield* attempt("pi.conversation.create", () => this.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT));
      const id = crypto.randomUUID();
      yield* attempt("session.write", () => this.ctx.storage.put(`session:${id}`, conversation.id));
      return { id };
    }));
  }

  private conversation = Effect.fn("Agent.conversation")(function*(this: Agent, id: string) {
    const conversationId = yield* attempt("session.read", () => this.ctx.storage.get<ConversationId>(`session:${id}`));
    if (conversationId === undefined) return Option.none();
    return Option.fromUndefinedOr(yield* attempt("pi.conversation.read", () => this.harness.conversation(conversationId, BACKGROUND_CONTEXT)));
  });

  prompt(id: string, content: string, requestId: string) {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const conversation = yield* this.conversation(id);
      if (Option.isNone(conversation)) return undefined;
      if (Option.isNone(yield* this.credentials.get("openai-codex"))) return { error: "Connect your Codex subscription first" };
      yield* this.arm({ active: true });
      const submission = yield* attempt("pi.submit", () => conversation.value.submit({ type: "input", content, requestId, whenBusy: "followUp" }, BACKGROUND_CONTEXT));
      return { submissionId: submission.id };
    }));
  }

  transcript(id: string) {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const conversation = yield* this.conversation(id);
      if (Option.isNone(conversation)) return undefined;
      return yield* Effect.acquireUseRelease(
        attempt("pi.watch", () => conversation.value.watch(BACKGROUND_CONTEXT)),
        (view) => this.credentials.get("openai-codex").pipe(Effect.map((credential) => {
          const value = Option.getOrUndefined(credential);
          return redact(JSON.stringify(view.value), value?.type === "oauth" ? [value.access, value.refresh] : []);
        })),
        (view) => attempt("pi.watch.stop", () => view.stop()).pipe(Effect.orDie),
      );
    }));
  }

  abort(id: string) {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const conversation = yield* this.conversation(id);
      if (Option.isNone(conversation)) return undefined;
      yield* attempt("pi.abort", () => conversation.value.abort(BACKGROUND_CONTEXT));
      return { state: "aborted" };
    }));
  }
}
