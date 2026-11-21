import { Hono, type Context } from "hono";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { rpc } from "./operations";
import { AddMcpServer, MCP_NAME, McpTokenInput, mcpDisplayName } from "./mcp";
import type { Env } from "./env";

/** Settings > Connections: MCP servers sessions get tools from (mcp.ts). */
export const mcpRoutes = new Hono<{ Bindings: Env }>();

const owner = (c: Context<{ Bindings: Env }>) => c.env.AGENT.getByName("owner");

async function body<A, I>(c: Context<{ Bindings: Env }>, schema: Schema.Codec<A, I>) {
  return Effect.runPromise(
    Effect.tryPromise(() => c.req.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.option,
    ),
  );
}

/** The server name in the path, or undefined when it could not be a server. */
function serverName(c: Context<{ Bindings: Env }>) {
  const name = c.req.param("name") ?? "";

  return MCP_NAME.test(name) ? name : undefined;
}

mcpRoutes.get("/api/connections", async (c) =>
  c.json(
    await Effect.runPromise(
      rpc(
        "mcp.connections",
        async () => await owner(c).mcpConnections(c.req.query("refresh") === "1"),
      ),
    ),
  ),
);

mcpRoutes.post("/api/connections/mcp", async (c) => {
  const parsed = await body(c, AddMcpServer);

  if (Option.isNone(parsed))
    return c.json({ error: "Expected a name, an http(s) URL and optional headers" }, 400);

  const result = await Effect.runPromise(
    rpc("mcp.add", async () => await owner(c).mcpAdd(parsed.value)),
  );

  return c.json(result, "error" in result ? 400 : 200);
});

mcpRoutes.delete("/api/connections/mcp/:name", async (c) => {
  const name = serverName(c);

  if (!name) return c.json({ error: "Unknown server" }, 404);

  const result = await Effect.runPromise(
    rpc("mcp.remove", async () => await owner(c).mcpRemove(name)),
  );

  return c.json(result, "error" in result ? 404 : 200);
});

mcpRoutes.get("/api/connections/mcp/:name/oauth", async (c) => {
  const name = serverName(c);

  if (!name) return c.json({ error: "Unknown server" }, 404);

  return c.json(
    await Effect.runPromise(
      rpc("mcp.oauth.status", async () => await owner(c).mcpOauthStatus(name)),
    ),
  );
});

mcpRoutes.post("/api/connections/mcp/:name/oauth/start", async (c) => {
  const name = serverName(c);

  if (!name) return c.json({ error: "Unknown server" }, 404);

  const result = await Effect.runPromise(
    rpc(
      "mcp.oauth.start",
      async () => await owner(c).mcpOauthStart(name, new URL(c.req.url).origin),
    ),
  );

  return c.json(result, "error" in result ? 409 : 200);
});

mcpRoutes.delete("/api/connections/mcp/:name/oauth", async (c) => {
  const name = serverName(c);

  if (!name) return c.json({ error: "Unknown server" }, 404);

  return c.json(
    await Effect.runPromise(
      rpc("mcp.oauth.disconnect", async () => await owner(c).mcpOauthDisconnect(name)),
    ),
  );
});

mcpRoutes.post("/api/connections/mcp/:name/token", async (c) => {
  const name = serverName(c);

  if (!name) return c.json({ error: "Unknown server" }, 404);
  const parsed = await body(c, McpTokenInput);

  if (Option.isNone(parsed)) return c.json({ error: "Expected a token" }, 400);

  const result = await Effect.runPromise(
    rpc("mcp.token", async () => await owner(c).mcpToken(name, parsed.value.token)),
  );

  return c.json(result, "error" in result ? 400 : 200);
});

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

function resultPage(title: string, message: string, status: 200 | 400) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1e1e;color:#ececec;font:15px/1.5 system-ui,sans-serif}
main{max-width:28rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{color:#a3a3a3;margin:0 0 1.25rem}
a{color:#ececec}
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="/settings/connections">Back to Connections</a></main></body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": "no-store",
    },
  });
}

/** The authorization server redirects the owner's browser here; Access and sign-in still apply. */
mcpRoutes.get("/api/connections/mcp-oauth/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const denied = c.req.query("error");

  if (denied || !state || !code)
    return resultPage(
      "Not connected",
      denied
        ? `The provider did not grant access (${c.req.query("error_description") || denied}).`
        : "The provider's response was missing its code. Start again from Connections.",
      400,
    );

  const result = await Effect.runPromise(
    rpc("mcp.oauth.complete", async () => await owner(c).mcpOauthComplete(state, code)),
  );

  if ("error" in result) return resultPage("Not connected", result.error, 400);

  return resultPage(
    `Connected ${mcpDisplayName(result.name)}`,
    "Sessions can now use its tools. You can close this tab.",
    200,
  );
});
