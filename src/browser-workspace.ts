import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { previewRequest } from "./preview";

/** The reserved sandbox host that brokers Cloudflare Browser Run over the DevTools protocol. */
export const BROWSER_HOST = "browser.workspace";

const BROWSER_PATH = "/devtools/browser";

/** Inside a brokered browser, this host serves the sandbox port chosen with ?port=. */
export const SANDBOX_HOST = "sandbox.workspace";

/** Forwards a brokered browser's requests for http://sandbox.workspace to one container port. */
export class SandboxOutbound extends WorkerEntrypoint<Env, { sandbox: string; port: number }> {
  override async fetch(request: Request) {
    const forwarded = previewRequest(request, SANDBOX_HOST);

    if (!forwarded) return new Response("Not found", { status: 404 });
    const { sandbox, port } = this.ctx.props;

    return this.env.SANDBOX.get(this.env.SANDBOX.idFromString(sandbox)).browserFetch(
      forwarded,
      port,
    );
  }
}

/** Browser Run sessions the deployment may hold open through the broker at once. */
export const MAX_BROWSER_SESSIONS = 4;

/** A brokered session is closed after this long, which also bounds a leaked lease. */
export const BROWSER_SESSION_MS = 30 * 60_000;

/** Counts open brokered sessions; the owner Agent implements it so the cap is deployment-wide. */
export type BrowserLeases = {
  acquireBrowser(): Promise<string | null>;
  releaseBrowser(lease: string): Promise<void>;
};

/** WebSocket close codes that may be sent explicitly; others become a normal closure. */
const closeCode = (code: number) =>
  code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000;

/**
 * Let code in the sandbox drive a Browser Run browser, with no credentials, tunnels or local
 * Chrome. `http://browser.workspace` behaves like a Chrome DevTools endpoint: /json/version
 * names a browser WebSocket, and each connection to it launches a fresh Browser Run session
 * through the Worker's binding. Network guardrails match the preview tool: only the
 * workspace's configured hosts are reachable from the browser itself. Connecting with
 * `?port=N` also lets the browser open http://sandbox.workspace, served from port N of this
 * workspace's container, with the application's credentials stripped.
 */
export async function browserRoute(
  request: Request,
  browser: Env["BROWSER"],
  networkHosts: readonly string[],
  leases: BrowserLeases,
  sandboxHost: (port: number) => Fetcher | undefined,
) {
  const url = new URL(request.url);

  if (url.protocol !== "http:" || url.port || url.username || url.password)
    return new Response("Use http://browser.workspace", { status: 400 });

  if (request.method === "GET" && url.pathname === "/json/version")
    return Response.json({
      Browser: "Cloudflare Browser Run",
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: `ws://${BROWSER_HOST}${BROWSER_PATH}`,
    });

  if (url.pathname !== BROWSER_PATH) return new Response("Not found", { status: 404 });

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return new Response("Expected a WebSocket upgrade", { status: 426 });

  const requested = url.searchParams.get("port");
  const port = requested === null ? undefined : Number(requested);

  if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535))
    return new Response("port must be an integer from 1024 to 65535", { status: 400 });

  // Guardrails block navigation before any client-side interception, so a page must load
  // from a host Browser Run routes through the Worker: the sandbox, when a port is given.
  const sandbox = port === undefined ? undefined : sandboxHost(port);

  if (port !== undefined && !sandbox)
    return new Response("This workspace has no sandbox to serve", { status: 409 });

  const lease = await leases.acquireBrowser();

  if (!lease)
    return new Response(
      `${MAX_BROWSER_SESSIONS} Browser Run sessions are already open; close one and retry`,
      { status: 429 },
    );

  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    void leases.releaseBrowser(lease).catch(() => {});
  };

  try {
    // Browser Run closes the session after keepAlive without a connected client.
    const connection = await browser.launch({
      keepAlive: 60_000,
      guardrails: { allowedDomains: [...networkHosts] },
      outboundByHost: sandbox ? { [SANDBOX_HOST]: sandbox } : {},
    });

    const reply = await connection.webSocket.fetch("https://browser-binding.invalid", {
      headers: { Upgrade: "websocket" },
    });

    if (!reply.webSocket) {
      release();

      return new Response("Browser Run did not return a WebSocket", { status: 502 });
    }

    // Relay through a fresh pair rather than returning Browser Run's upgrade response,
    // whose Upgrade/Connection headers would be duplicated and break strict clients.
    const upstream = reply.webSocket;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    upstream.accept();
    server.accept();

    const timer = setTimeout(
      () => close(1000, "Browser session time limit reached"),
      BROWSER_SESSION_MS,
    );

    function close(code: number, reason: string) {
      clearTimeout(timer);
      release();

      for (const socket of [upstream, server])
        try {
          socket.close(closeCode(code), reason);
        } catch {
          // Already closed.
        }
    }

    upstream.addEventListener("message", (event) => server.send(event.data));
    server.addEventListener("message", (event) => upstream.send(event.data));

    for (const socket of [upstream, server]) {
      socket.addEventListener("close", (event) => close(event.code, event.reason));
      socket.addEventListener("error", () => close(1011, "Browser connection failed"));
    }

    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    release();
    throw error;
  }
}
