import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import type { Env } from "./env";

/**
 * How Dolly sends Claude requests. `direct` calls Anthropic from the Worker, presenting the setup
 * token the way Claude Code would. `claude-code` runs each request through the real Claude Code,
 * via the Claude Agent SDK in Dolly's Claude Code container (claude-bridge/, after Open Session's
 * anthropic-bridge).
 */
export const ClaudeTransport = Schema.Literals(["direct", "claude-code"]);

export type ClaudeTransport = typeof ClaudeTransport.Type;

export const DEFAULT_CLAUDE_TRANSPORT: ClaudeTransport = "direct";

export const CLAUDE_TRANSPORT_KEY = "settings:claude-transport";

export const ClaudeTransportSetting = Schema.Struct({ transport: ClaudeTransport });

/** The one Claude Code container every session shares. */
export const CLAUDE_CODE_INSTANCE = "claude-code";

/** Where the provider addresses Claude Code. Never resolved: requests go to the Durable Object. */
export const CLAUDE_CODE_BASE_URL = "https://claude-code.bridge";

/**
 * What the provider presents as its API key on the way to Claude Code. Not a credential: the
 * bridge never reads it, and not being a setup token keeps Pi from dressing the request up as
 * Claude Code itself.
 */
export const CLAUDE_CODE_API_KEY = "dolly-claude-code-bridge";

const PORT = 8080;
const CA_BUNDLE = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const READY_TIMEOUT_MS = 60_000;

/**
 * Long enough for Claude Code's sessions to stay warm between turns, and past the bridge's longest
 * wait for a tool result (TOOL_WAIT_MS in claude-bridge/src/bridge.ts, 70 minutes): while Dolly runs
 * an hour-long command no request reaches the container, and stopping it would lose the waiting
 * tool call and send the session to a full replay.
 */
const INACTIVITY_TIMEOUT_MS = 75 * 60_000;

/** The only host Claude Code may reach, and only through the Worker. */
export const ANTHROPIC_HOST = "api.anthropic.com";

interface ClaudeCodeState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & {
    ClaudeCodeOutbound: LoopbackForExport<typeof ClaudeCodeOutbound>;
  };
}

/**
 * Owns Dolly's Claude Code container: a trusted image that only runs the bridge. It is separate
 * from the repository sandboxes, where the agent runs arbitrary commands, and it never holds the
 * owner's token: Claude Code authenticates with a placeholder that ClaudeCodeOutbound replaces.
 */
export class ClaudeCode extends DurableObject<Env> {
  private ready: Promise<Container> | undefined;
  private readonly loopback: ClaudeCodeState["exports"];

  constructor(ctx: ClaudeCodeState, env: Env) {
    super(ctx, env);
    this.loopback = ctx.exports;
  }

  /** The per-deployment key every bridge request presents; kept so a live container keeps it. */
  private async key() {
    const stored = await this.ctx.storage.get<string>("bridge-key");

    if (stored) return stored;
    const key = crypto.randomUUID();
    await this.ctx.storage.put("bridge-key", key);

    return key;
  }

  private async start() {
    const container = this.ctx.container;

    if (!container) throw new Error("The Claude Code container is not configured");
    const key = await this.key();

    if (!container.running)
      container.start({
        image: container.images.claude,
        instance: "standard-2",
        enableInternet: false,
        env: {
          PORT: String(PORT),
          DOLLY_BRIDGE_KEY: key,
          NODE_EXTRA_CA_CERTS: CA_BUNDLE,
          SSL_CERT_FILE: CA_BUNDLE,
        },
      });

    // A fresh object re-arms interception even for a container that outlived the last one.
    const outbound = this.loopback.ClaudeCodeOutbound({ props: {} });
    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps("*", outbound);

    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const health = await container.getTcpPort(PORT).fetch("http://localhost/health", {
          signal: AbortSignal.timeout(1000),
        });

        await health.body?.cancel();

        if (health.ok) return container;
      } catch {
        // Connection refused until the server listens.
      }

      await scheduler.wait(250);
    }

    throw new Error("Claude Code did not start within 60 seconds");
  }

  private container() {
    const container = this.ctx.container;

    if (this.ready && container?.running) return this.ready;
    const ready = this.start();
    this.ready = ready;
    ready.catch(() => {
      if (this.ready === ready) this.ready = undefined;
    });

    return ready;
  }

  /** Serve one Anthropic Messages API request through Claude Code. */
  override async fetch(request: Request) {
    const container = await this.container();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("x-dolly-bridge-key", await this.key());

    return container.getTcpPort(PORT).fetch(`http://localhost${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
    });
  }
}

/**
 * The Claude Code container's only way out: Anthropic's API, through the owner Agent, which
 * replaces Claude Code's placeholder token with the owner's. Every other destination is refused.
 */
export class ClaudeCodeOutbound extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.protocol !== "https:" || url.port || url.hostname !== ANTHROPIC_HOST)
      return new Response("Claude Code may only reach api.anthropic.com", { status: 403 });

    return this.env.AGENT.getByName("owner").claudeCodeUpstream(request);
  }
}
