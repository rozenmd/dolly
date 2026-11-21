import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { headers, signIn } from "./session";
import { Live, Snapshot } from "../src/transcript";
import type { McpToolInput } from "../src/mcp";

/**
 * Settings > Connections (src/mcp.ts) through the real API routes and owner Durable Object:
 * adding servers, live status, the browser OAuth flow with dynamic registration, API-token
 * connect, and the `mcp` tool a session calls. Only outbound fetch is simulated.
 */

const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;

const call = <A>(path: string, method = "GET", body?: A) =>
  SELF.fetch(`https://worker/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });

type Handler = (
  url: URL,
  init: RequestInit | undefined,
  request: Request,
) => Response | Promise<Response>;

/** Route outbound fetches by origin+path; anything unexpected fails the request. */
function network(routes: Record<string, Handler>) {
  const seen: { url: string; method: string; headers: Headers; body: string }[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    const body =
      request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();

    seen.push({ url: url.href, method: request.method, headers: request.headers, body });

    const handler =
      routes[`${request.method} ${url.origin}${url.pathname}`] ??
      routes[`${url.origin}${url.pathname}`] ??
      routes[`${request.method} ${url.origin}/*`];

    if (!handler) throw new Error(`Unexpected request ${request.method} ${url.href}`);

    return handler(url, init, request);
  });

  return seen;
}

const LINEAR = "https://mcp.linear.example";

/** A spec-following OAuth-protected MCP server: 401 with resource metadata, AS metadata, DCR. */
function oauthServer(
  origin: string,
  mcp: Handler = () => {
    throw new Error("Unexpected MCP request");
  },
) {
  return {
    [`GET ${origin}/mcp`]: () =>
      new Response("unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      }),
    [`POST ${origin}/mcp`]: mcp,
    [`DELETE ${origin}/mcp`]: () => new Response(null, { status: 204 }),
    [`${origin}/.well-known/oauth-protected-resource/mcp`]: () =>
      Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["read", "write"],
      }),
    [`${origin}/.well-known/oauth-authorization-server`]: () =>
      Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      }),
    [`POST ${origin}/register`]: () =>
      Response.json({ client_id: "dolly-client" }, { status: 201 }),
  } satisfies Record<string, Handler>;
}

const RpcRequest = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});

/** An MCP endpoint answering initialize, tools/list and tools/call, in SSE like many servers. */
function mcpEndpoint(
  calls: { method: string; authorization: string | null; session: string | null }[],
): Handler {
  return async (_url, _init, request) => {
    const message = Schema.decodeUnknownSync(Schema.fromJsonString(RpcRequest))(
      await request.text(),
    );

    calls.push({
      method: message.method,
      authorization: request.headers.get("authorization"),
      session: request.headers.get("mcp-session-id"),
    });

    if (message.id === undefined) return new Response(null, { status: 202 });
    const id = message.id;

    const respond = (result: string) =>
      new Response(`event: message\ndata: {"jsonrpc":"2.0","id":${id},"result":${result}}\n\n`, {
        headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "session-1" },
      });

    if (message.method === "initialize")
      return respond(
        JSON.stringify({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "linear", version: "1" },
        }),
      );

    if (message.method === "tools/list")
      return respond(
        JSON.stringify({
          tools: [
            {
              name: "create_issue",
              description: "Create a Linear issue",
              inputSchema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          ],
        }),
      );

    if (message.method === "tools/call")
      return respond(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: `Created ${JSON.stringify(message.params?.arguments)} via ${message.params?.name}`,
            },
          ],
        }),
      );

    return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });
  };
}

const Connections = Schema.Struct({
  mcpServers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      transport: Schema.String,
      target: Schema.String,
      headerKeys: Schema.Array(Schema.String),
      status: Schema.String,
      detail: Schema.optional(Schema.String),
    }),
  ),
});

async function connections(refresh = true) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Connections))(
    await (await call(`/connections${refresh ? "?refresh=1" : ""}`)).text(),
  ).mcpServers;
}

beforeEach(async () => {
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    for (const key of (await state.storage.list({ prefix: "mcp:" })).keys())
      await state.storage.delete(key);
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("requires sign-in, validates servers, reports live status and never returns header values", async () => {
  expect((await SELF.fetch("https://worker/api/connections")).status).toBe(401);

  network({
    ...oauthServer(LINEAR),
    "GET https://keyed.example/mcp": () => new Response("method not allowed", { status: 405 }),
    "GET https://down.example/mcp": () => {
      throw new Error("connect ECONNREFUSED");
    },
  });

  expect(
    await (
      await call("/connections/mcp", "POST", { name: "bad name", url: `${LINEAR}/mcp` })
    ).json(),
  ).toEqual({
    error: "Name must be alphanumeric (dashes/underscores allowed)",
  });
  expect(
    (await call("/connections/mcp", "POST", { name: "x", url: "ftp://files.example" })).status,
  ).toBe(400);
  expect(
    (await call("/connections/mcp", "POST", { name: "linear", url: `${LINEAR}/mcp` })).status,
  ).toBe(200);
  expect(
    await (await call("/connections/mcp", "POST", { name: "linear", url: `${LINEAR}/mcp` })).json(),
  ).toEqual({
    error: 'Server "linear" already exists — remove it first',
  });
  expect(
    (
      await call("/connections/mcp", "POST", {
        name: "keyed",
        url: "https://keyed.example/mcp?token=secret-in-query",
        headers: { Authorization: "Bearer static-key-123456" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await call("/connections/mcp", "POST", { name: "down", url: "https://down.example/mcp" }))
      .status,
  ).toBe(200);

  const listed = await connections();
  expect(listed).toEqual([
    {
      name: "linear",
      transport: "http",
      target: `${LINEAR}/mcp`,
      headerKeys: [],
      status: "needs-auth",
      detail: "OAuth sign-in required — Connect from this card's menu",
    },
    {
      name: "keyed",
      transport: "http",
      target: "https://keyed.example/mcp",
      headerKeys: ["Authorization"],
      status: "connected",
      detail: "HTTP 405",
    },
    {
      name: "down",
      transport: "http",
      target: "https://down.example/mcp",
      headerKeys: [],
      status: "unreachable",
      detail: "connect ECONNREFUSED",
    },
  ]);
  expect(JSON.stringify(listed)).not.toContain("static-key");
  expect(JSON.stringify(listed)).not.toContain("secret-in-query");

  expect((await call("/connections/mcp/down", "DELETE")).status).toBe(200);
  expect((await call("/connections/mcp/down", "DELETE")).status).toBe(404);
  expect((await connections()).map((server) => server.name)).toEqual(["linear", "keyed"]);
});

it("connects with OAuth through dynamic registration and PKCE, then disconnects", async () => {
  const tokenRequests: URLSearchParams[] = [];

  const seen = network({
    ...oauthServer(LINEAR),
    [`POST ${LINEAR}/token`]: async (_url, _init, request) => {
      tokenRequests.push(new URLSearchParams(await request.text()));

      return Response.json({
        access_token: "linear-access",
        refresh_token: "linear-refresh",
        expires_in: 3600,
      });
    },
  });

  await call("/connections/mcp", "POST", { name: "linear", url: `${LINEAR}/mcp` });
  expect(await (await call("/connections/mcp/linear/oauth")).json()).toEqual({
    users: [],
    manualToken: false,
  });

  const started = await call("/connections/mcp/linear/oauth/start", "POST", {});
  expect(started.status).toBe(200);
  const authorize = new URL((await started.json<{ url: string }>()).url);

  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${LINEAR}/authorize`);
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "dolly-client",
    redirect_uri: "https://worker/api/connections/mcp-oauth/callback",
    code_challenge_method: "S256",
    scope: "read write",
    resource: `${LINEAR}/mcp`,
  });

  const registration = seen.find((request) => request.url === `${LINEAR}/register`);
  expect(JSON.parse(registration!.body)).toMatchObject({
    redirect_uris: ["https://worker/api/connections/mcp-oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  // A forged or replayed state never reaches the token endpoint.
  const forged = await call("/connections/mcp-oauth/callback?state=forged&code=abc");
  expect(forged.status).toBe(400);
  expect(await forged.text()).toContain("expired");
  expect(tokenRequests).toHaveLength(0);

  const state = authorize.searchParams.get("state")!;
  const callback = await call(`/connections/mcp-oauth/callback?state=${state}&code=the-code`);
  expect(callback.status).toBe(200);
  expect(callback.headers.get("content-type")).toContain("text/html");
  expect(await callback.text()).toContain("Connected Linear");

  // The PKCE verifier matches the challenge sent to the browser.
  const verifier = tokenRequests[0].get("code_verifier")!;

  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );

  const challenge = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  expect(challenge).toBe(authorize.searchParams.get("code_challenge"));
  expect(Object.fromEntries(tokenRequests[0])).toMatchObject({
    grant_type: "authorization_code",
    code: "the-code",
    client_id: "dolly-client",
  });

  expect((await call(`/connections/mcp-oauth/callback?state=${state}&code=the-code`)).status).toBe(
    400,
  );
  expect(await (await call("/connections/mcp/linear/oauth")).json()).toMatchObject({
    shared: { connectedBy: "octocat" },
    users: [],
  });
  expect((await connections())[0]).toMatchObject({ status: "connected", detail: "HTTP 401" });

  expect(await (await call("/connections/mcp/linear/oauth", "DELETE")).json()).toEqual({
    ok: true,
  });
  expect((await connections())[0].status).toBe("needs-auth");
});

it("validates pasted API tokens with the provider before storing them", async () => {
  network({
    "GET https://mcp.vercel.com/": () => new Response("unauthorized", { status: 401 }),
    "GET https://api.vercel.com/v2/user": (_url, _init, request) =>
      request.headers.get("authorization") === "Bearer good-token"
        ? Response.json({ user: { username: "octocat" } })
        : new Response("forbidden", { status: 403 }),
  });

  await call("/connections/mcp", "POST", { name: "vercel", url: "https://mcp.vercel.com/" });
  expect((await connections())[0]).toMatchObject({
    status: "needs-auth",
    detail: "API token required. Connect from this card's menu",
  });

  const rejected = await call("/connections/mcp/vercel/token", "POST", { token: "bad-token" });
  expect(rejected.status).toBe(400);
  expect((await rejected.json<{ error: string }>()).error).toContain("Vercel rejected that token");

  expect(
    (await call("/connections/mcp/vercel/token", "POST", { token: "good-token" })).status,
  ).toBe(200);
  expect(await (await call("/connections/mcp/vercel/oauth")).json()).toMatchObject({
    shared: {},
    manualToken: true,
  });
  expect((await connections())[0].status).toBe("connected");
});

type CodexItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      status: "completed";
      content: { type: "output_text"; text: string; annotations: never[] }[];
    }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string };

/** Codex SSE for one output item. */
function sse(item: CodexItem) {
  const events = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

const toolCall = (args: typeof McpToolInput.Type) =>
  sse({
    type: "function_call",
    id: `fc_${crypto.randomUUID()}`,
    call_id: `call_${crypto.randomUUID()}`,
    name: "mcp",
    arguments: JSON.stringify(args),
  });

const answer = (text: string) =>
  sse({
    type: "message",
    id: "msg_test",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot));

it("lets a session list and call a connected server's tools with a refreshed grant", async () => {
  const mcpCalls: { method: string; authorization: string | null; session: string | null }[] = [];

  const replies = [
    () => toolCall({ action: "servers" }),
    () => toolCall({ action: "list_tools", server: "linear" }),
    () =>
      toolCall({
        action: "call_tool",
        server: "linear",
        tool: "create_issue",
        arguments: { title: "Fix login" },
      }),
    () => toolCall({ action: "list_tools", server: "missing" }),
    () => answer("Filed it"),
  ];

  const prompts: string[] = [];
  const refreshes: URLSearchParams[] = [];

  const model: Handler = async (_url, _init, request) => {
    prompts.push(await request.text());
    const next = replies.shift();

    if (!next) throw new Error("Unexpected model request");

    return next();
  };

  network({
    ...oauthServer(LINEAR, mcpEndpoint(mcpCalls)),
    [`POST ${LINEAR}/token`]: async (_url, _init, request) => {
      refreshes.push(new URLSearchParams(await request.text()));

      return Response.json({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      });
    },
    "POST https://api.openai.com/*": model,
    "POST https://chatgpt.com/*": model,
  });

  await call("/connections/mcp", "POST", { name: "linear", url: `${LINEAR}/mcp` });

  // A grant that expired a minute ago: the first use refreshes it with the refresh token.
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
    await state.storage.put("mcp:auth:linear", {
      serverUrl: `${LINEAR}/mcp`,
      redirectUri: "https://worker/api/connections/mcp-oauth/callback",
      endpoints: { authorize: `${LINEAR}/authorize`, token: `${LINEAR}/token` },
      clientId: "dolly-client",
      shared: {
        tokens: {
          accessToken: "stale-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() - 60_000,
        },
        updatedAt: new Date(Date.now() - 3_660_000).toISOString(),
      },
    });
  });

  const created = await SELF.fetch("https://worker/api/sessions", { method: "POST", headers });
  const { id } = await created.json<{ id: string }>();

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "File a Linear issue to fix login",
      requestId: crypto.randomUUID(),
    }),
  });

  expect(sent.status).toBe(202);

  let snapshot: typeof Snapshot.Type | undefined;
  await expect
    .poll(
      async () => {
        snapshot = decode(
          await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text(),
        );

        const live = Option.getOrUndefined(
          Schema.decodeUnknownOption(Live)(snapshot.docs["pi.live"]),
        );

        return live !== undefined && live.run === undefined && replies.length === 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // The model is told which servers exist and offered the tool.
  expect(prompts[0]).toContain("Connected MCP servers, usable through the mcp tool: linear");
  expect(prompts[0]).toContain('"name":"mcp"');

  const results = snapshot!.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "toolResult" && message.toolName === "mcp" && Array.isArray(message.content)
        ? [
            {
              text: message.content.map((block) => block.text ?? "").join(""),
              isError: message.isError,
            },
          ]
        : [],
    ),
  );

  expect(JSON.parse(results[0].text)).toEqual({
    servers: [{ name: "linear", target: `${LINEAR}/mcp`, status: "connected" }],
  });
  expect(JSON.parse(results[1].text)).toMatchObject({
    server: "linear",
    tools: [
      {
        name: "create_issue",
        description: "Create a Linear issue",
        inputSchema: { required: ["title"] },
      },
    ],
  });
  expect(results[2]).toEqual({
    text: 'Created {"title":"Fix login"} via create_issue',
    isError: false,
  });
  expect(results[3].isError).toBe(true);
  expect(results[3].text).toContain('No MCP server named "missing"');

  // One refresh, then every request carries the fresh token and the server's session id.
  expect(refreshes).toHaveLength(1);
  expect(Object.fromEntries(refreshes[0])).toMatchObject({
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
  });
  expect(mcpCalls.map((entry) => entry.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  expect(new Set(mcpCalls.map((entry) => entry.authorization))).toEqual(
    new Set(["Bearer fresh-access"]),
  );
  expect(
    mcpCalls
      .filter((entry) => entry.method !== "initialize")
      .every((entry) => entry.session === "session-1"),
  ).toBe(true);

  // Tokens never reach the transcript.
  expect(JSON.stringify(snapshot)).not.toContain("fresh-access");
}, 30_000);
