import type { Env } from "./env";

/** The reserved sandbox host that brokers Cloudflare Browser Run over the DevTools protocol. */
export const BROWSER_HOST = "browser.workspace";

const BROWSER_PATH = "/devtools/browser";

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
 * workspace's configured hosts are reachable from the browser itself.
 */
export async function browserRoute(
  request: Request,
  browser: Env["BROWSER"],
  networkHosts: readonly string[],
  leases: BrowserLeases,
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
