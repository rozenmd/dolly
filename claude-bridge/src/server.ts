/**
 * The bridge's HTTP server inside Dolly's Claude Code container. It listens on PORT for the
 * Worker's ClaudeBridge Durable Object, the only caller that can reach the container.
 *
 * Claude Code never holds the owner's token. It authenticates with a placeholder, and the Worker's
 * outbound handler for this container replaces it with the real token on requests to Anthropic and
 * refuses every other destination.
 */
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createBridge, type ClaudeEnv } from "./bridge.ts";

declare global {
  namespace NodeJS {
    interface ProcessReport {
      /** Node 22.13+ and 23.3+: leave the network section out of reports. Missing from @types/node. */
      excludeNetwork: boolean;
    }
  }
}

/** What Claude Code sends as its subscription token; the Worker swaps it for the real one. */
export const PLACEHOLDER_TOKEN = "sk-ant-oat01-dolly-claude-code-bridge-placeholder-token";

/** Claude Code's credential and traffic switches, the same for every process. */
const CLAUDE_CODE_SWITCHES = {
  CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_TOKEN,
  // Only Anthropic's API is reachable: keep Claude Code off telemetry, error reporting, the
  // auto-updater and claude.ai's MCP connectors.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  // Send every client tool with each request. Tool search would defer them behind a ToolSearch
  // call the bridge can't run, and add a placeholder tool the client never declared.
  ENABLE_TOOL_SEARCH: "false",
};

/** Environment for every Claude Code process the bridge starts. */
export function claudeEnv(source: NodeJS.ProcessEnv) {
  const env: ClaudeEnv = { ...CLAUDE_CODE_SWITCHES };

  // The container's CA for intercepted HTTPS, and a test upstream.
  for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "ANTHROPIC_BASE_URL"]) {
    const value = source[name];

    if (value) env[name] = value;
  }

  return env;
}

/** Adapt a Node request to a fetch Request whose signal aborts when the client disconnects. */
function toRequest(incoming: IncomingMessage, outgoing: ServerResponse) {
  const controller = new AbortController();

  outgoing.on("close", () => {
    if (!outgoing.writableFinished) controller.abort();
  });

  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers))
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);

  const init: RequestInit & { duplex?: "half" } = {
    method: incoming.method,
    headers,
    signal: controller.signal,
  };

  if (incoming.method !== "GET" && incoming.method !== "HEAD") {
    // SAFETY: Readable.toWeb yields the byte chunks of the request body.
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  return new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, init);
}

async function respond(response: Response, outgoing: ServerResponse) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  // A streamed reply opens at once, before Claude Code has written anything.
  outgoing.flushHeaders();

  if (!response.body) {
    outgoing.end();

    return;
  }

  const reader = response.body.getReader();
  outgoing.on("close", () => void reader.cancel().catch(() => undefined));

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) break;
    outgoing.write(chunk.value);
  }

  outgoing.end();
}

export function startServer(port: number, source: NodeJS.ProcessEnv) {
  // The SDK reads a process report to pick its platform binary for every query. With open sockets
  // the report's network section resolves each one and stalls a request for about 30 seconds.
  process.report.excludeNetwork = true;

  const cwd = source.BRIDGE_CWD ?? `${source.HOME ?? "/tmp"}/bridge-cwd`;
  mkdirSync(cwd, { recursive: true });

  const bridge = createBridge({ claudeEnv: claudeEnv(source), cwd, key: source.DOLLY_BRIDGE_KEY });

  const server = createServer((incoming, outgoing) => {
    bridge
      .fetch(toRequest(incoming, outgoing))
      .then((response) => respond(response, outgoing))
      .catch((error) => {
        console.error("bridge request failed", error);

        if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(
          JSON.stringify({ type: "error", error: { type: "api_error", message: "bridge failed" } }),
        );
      });
  });

  server.on("close", () => bridge.close());

  // Claude Code turns can run for many minutes.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.listen(port, "0.0.0.0");

  return server;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  startServer(port, process.env).on("listening", () => console.log(`claude bridge on :${port}`));
}
