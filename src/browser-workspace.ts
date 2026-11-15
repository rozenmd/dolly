import type { Env } from "./env";

/** The reserved sandbox host that brokers Cloudflare Browser Run over the DevTools protocol. */
export const BROWSER_HOST = "browser.workspace";

const BROWSER_PATH = "/devtools/browser";

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

  // Browser Run closes the session after keepAlive without a connected client.
  const connection = await browser.launch({
    keepAlive: 60_000,
    guardrails: { allowedDomains: [...networkHosts] },
  });

  // The binding's session-pinned Fetcher returns the browser-level CDP WebSocket as-is.
  return connection.webSocket.fetch("https://browser-binding.invalid", {
    headers: { Upgrade: "websocket" },
  });
}
