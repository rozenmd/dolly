import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { configure, createRegistry, defineExtension, Harness, section, type ConversationId, type ToolRegistration, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { obj, str } from "@earendil-works/pi-schema";
import { Credentials } from "./credentials";
import { CodexLogin } from "./codex-login";
import { exceptionDetails, redact } from "./diagnostics";
import type { Env } from "./env";

export class Agent extends DurableObject<Env> {
  private harness!: Harness;
  private readonly credentials: Credentials;
  private readonly login: CodexLogin;
  private alarmWrites: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.credentials = new Credentials(ctx.storage);
    this.login = new CodexLogin(ctx.storage, this.credentials);
    void ctx.blockConcurrencyWhile(() => this.initialize());
  }

  private async initialize() {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const models = createModels({ credentials: this.credentials });
    const provider = openaiCodexProvider();
    const oauth = provider.auth.oauth;
    if (!oauth) throw new Error("Codex provider must support OAuth");
    models.setProvider({ ...provider, auth: { oauth: {
      ...oauth,
      refresh: async (credential, signal) => {
        try {
          return await oauth.refresh(credential, signal);
        } catch (error) {
          throw new Error(exceptionDetails(error, [credential.access, credential.refresh]).message);
        }
      },
    } } });
    const shell = {
      name: "shell",
      description: "Run a shell command in this conversation's Linux sandbox, in /workspace. Network is disabled. Output is capped at 32 KiB per stream, time at 60 seconds. Files are ephemeral across container restarts.",
      parameters: obj({ command: str() }),
      replay: "unsafe",
      executionMode: "sequential",
      execute: async ({ command }: { command: string }, api) => ({
        output: [{ type: "text", text: JSON.stringify(await this.env.SANDBOX.getByName(String(api.conversationId)).run(command)) }],
      }),
    } satisfies ToolRegistration;
    const readFile = {
      name: "read_file",
      description: "Read a UTF-8 file in this conversation's sandbox, maximum 64 KiB. Relative paths use /workspace.",
      parameters: obj({ path: str() }),
      replay: "safe",
      execute: async ({ path }: { path: string }, api) => ({
        output: [{ type: "text", text: await this.env.SANDBOX.getByName(String(api.conversationId)).readFile(path.startsWith("/") ? path : `/workspace/${path}`) }],
      }),
    } satisfies ToolRegistration;
    const extension = defineExtension({
      name: "sandbox",
      tools: [shell, readFile],
      sections: [section("preamble", () => "You are a coding assistant. Use the Linux sandbox for commands and files. Never claim a command ran unless its tool result confirms it.", { tag: false })],
    });
    const registry = createRegistry();
    registry.install(extension);
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    this.harness = await Harness.open(storage, {
      models,
      registry,
      settings: { extensions: [extension], stream: { transport: "sse", timeoutMs: 120_000 } },
      conversationCreated: (tx, conversation) => configure(tx, conversation.id, {
        model: { provider: "openai-codex", modelId: this.env.CODEX_MODEL },
        thinkingLevel: "low",
        maxTurns: 20,
        tools: [shell, readFile],
      }),
      onWake: (wake) => { void this.arm(wake).catch(() => this.ctx.abort("Alarm persistence failed")); },
      onReport: ({ error, ...report }) => {
        void this.credentials.read("openai-codex").then((credential) => {
          const secrets = credential?.type === "oauth" ? [credential.access, credential.refresh] : [];
          console.error(JSON.stringify({ event: "agent_failure", ...report, error: exceptionDetails(error, secrets) }));
        });
      },
    }, BACKGROUND_CONTEXT);
    void this.harness.closed.then((end) => {
      if (end.kind === "failed") this.ctx.abort("Harness storage failed");
    });
    await this.arm(this.harness.wake());
    this.harness.resume();
  }

  private arm(wake: Wake) {
    const next = this.alarmWrites.then(async () => {
      const at = wake.active ? Math.min(Date.now() + 60_000, wake.at ?? Infinity) : wake.at;
      if (at === undefined) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
    });
    this.alarmWrites = next.catch(() => undefined);
    return next;
  }

  override async alarm() {
    await this.arm({ ...this.harness.wake(), active: true });
    this.harness.resume();
    await this.arm(this.harness.wake());
  }

  async startLogin() { return await this.login.start(); }
  async pollLogin() { return await this.login.poll(); }
  async logout() { return await this.login.logout(); }

  async createSession() {
    if (!await this.credentials.read("openai-codex")) return { error: "Connect your Codex subscription first" };
    const conversation = await this.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const id = crypto.randomUUID();
    await this.ctx.storage.put(`session:${id}`, conversation.id);
    return { id };
  }

  private async conversation(id: string) {
    const conversationId = await this.ctx.storage.get<ConversationId>(`session:${id}`);
    return conversationId === undefined ? undefined : this.harness.conversation(conversationId, BACKGROUND_CONTEXT);
  }

  async prompt(id: string, content: string, requestId: string) {
    const conversation = await this.conversation(id);
    if (!conversation) return undefined;
    if (!await this.credentials.read("openai-codex")) return { error: "Connect your Codex subscription first" };
    await this.arm({ active: true });
    const submission = await conversation.submit({ type: "input", content, requestId, whenBusy: "followUp" }, BACKGROUND_CONTEXT);
    return { submissionId: submission.id };
  }

  async transcript(id: string) {
    const conversation = await this.conversation(id);
    if (!conversation) return undefined;
    const view = await conversation.watch(BACKGROUND_CONTEXT);
    try {
      const credential = await this.credentials.read("openai-codex");
      return redact(JSON.stringify(view.value), credential?.type === "oauth" ? [credential.access, credential.refresh] : []);
    } finally {
      await view.stop();
    }
  }

  async abort(id: string) {
    const conversation = await this.conversation(id);
    if (!conversation) return undefined;
    await conversation.abort(BACKGROUND_CONTEXT);
    return { state: "aborted" };
  }
}
