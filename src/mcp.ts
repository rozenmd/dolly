/**
 * MCP connections: the remote MCP servers agent sessions get tools from, ported from
 * Opensession's Connections (connections.ts, mcp-oauth.ts and McpConnectionForms.tsx).
 *
 * Servers live in the owner Durable Object's storage instead of mcp-config.json. Status checks,
 * the browser OAuth 2.1 + PKCE flow (RFC 9728 discovery, RFC 7591 dynamic registration),
 * lazy token refresh and paste-a-token connect for providers that gate OAuth registration
 * work as they do in Opensession. Owner web sessions reach the servers through the `mcp` tool,
 * a code mode program (src/mcp-codemode.ts, after opencode) whose every tool call comes back here
 * to the Worker: tokens and static headers never enter the program or a sandbox. The protocol
 * itself is the official MCP SDK (src/mcp-client.ts), which also speaks the 2026-07-28 revision.
 *
 * Differences from Opensession, because Dolly runs on Workers with a single owner:
 *  - Only remote (streamable HTTP) servers. A Worker cannot spawn stdio processes, and running
 *    them inside a session sandbox would hand it the server's credentials.
 *  - One workspace grant per server; there are no per-teammate grants. A server may carry an
 *    `allowedUsers` list, as in Opensession: empty means every writable session gets it; otherwise
 *    Slack and GitHub sessions get it only when the person who started them is listed
 *    (`mcpUserAllowed`). Owner web sessions always get every server.
 *  - The add form also takes static headers, because there is no config file to edit by hand.
 *  - No Client ID Metadata Document: authorization servers must offer dynamic registration.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type CatalogTool,
  catalogPrompt,
  CODE_LIMITS,
  decodeJsonObject,
  MCP_CODE_DESCRIPTION,
  resultOutput,
  runCode,
} from "./mcp-codemode";
import {
  type ListedTool,
  type McpSession,
  openMcpSession,
  type PriorDiscovery,
} from "./mcp-client";
import { discoverMcpOauth, OauthDiscoveryError } from "./mcp-oauth-discovery";

const SERVERS_KEY = "mcp:servers";
const authKey = (name: string) => `mcp:auth:${name}`;
const pendingKey = (state: string) => `mcp:pending:${state}`;
const toolsKey = (name: string) => `mcp:tools:${name}`;

export const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

export const MCP_TOOL_NAME = "mcp";

export interface McpServerEntry {
  type: "http";
  /** New for every add, so a removed and re-added name never inherits old grants or flows. */
  id: string;
  /**
   * Bumped by Disconnect. Sign-ins, registrations and token checks capture it when they start
   * and write nothing if it moved, so Disconnect wins even over a first connection in flight.
   */
  epoch?: number;
  url: string;
  /** Static request headers (API keys). Never returned by the API. */
  headers?: Record<string, string>;
  /**
   * Who besides the owner may use it, as Slack member IDs or GitHub logins. Empty or unset: any
   * writable session. Set: Slack and GitHub sessions only when their starter is listed.
   */
  allowedUsers?: string[];
}

export interface McpConnection {
  name: string;
  transport: "http";
  /** Sanitized: origin and path only, since query strings can embed tokens. */
  target: string;
  /** Names of static headers, never their values. */
  headerKeys: string[];
  /** Empty when every writable session may use the server (see McpServerEntry.allowedUsers). */
  allowedUsers: string[];
  status: "connected" | "needs-auth" | "unreachable";
  detail?: string;
}

export interface McpOauthStatus {
  shared?: { connectedBy?: string; updatedAt: string };
  /** Always empty: Dolly has one owner, so grants are workspace grants. */
  users: string[];
  manualToken: boolean;
}

interface Grant {
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number };
  updatedAt: string;
  connectedBy?: string;
}

interface ServerAuth {
  /** The McpServerEntry id this registration and grant belong to. */
  serverId: string;
  /** The server entry's epoch this record was written under; any other epoch is stale. */
  epoch: number;
  serverUrl: string;
  redirectUri: string;
  resource?: string;
  scopes?: string[];
  endpoints: { authorize: string; token: string; register?: string };
  clientId: string;
  shared?: Grant;
}

/** A server's tools as last listed, bound like a grant to the server, URL and epoch. */
interface ToolList {
  serverId: string;
  url: string;
  epoch: number;
  fetchedAt: number;
  /** False when listing stopped early (page, size or tool budget, or a repeating cursor). */
  complete: boolean;
  tools: CatalogTool[];
}

interface PendingFlow {
  name: string;
  serverId: string;
  epoch: number;
  verifier: string;
  redirectUri: string;
  connectedBy?: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const STATUS_TTL_MS = 60_000;
const CAPABLE_TTL_MS = 60 * 60_000;
const CAPABLE_ERROR_TTL_MS = 60_000;
const REFRESH_AHEAD_MS = 5 * 60_000;

/** tools/list pages read before stopping. */
const MAX_TOOL_PAGES = 20;

/** JSON characters of one server's compacted tool list, the most a listing keeps in memory. */
const MAX_CATALOG_CHARS = 512 * 1024;

const MAX_TOOLS = 500;

const MAX_TOOL_DESCRIPTION = 2_000;

/** A tool's input schema larger than this is dropped; its errors still say what it expects. */
const MAX_SCHEMA_CHARS = 16 * 1024;

/** How long a cached tool list is used before the next run lists the server again. */
const TOOLS_TTL_MS = 60 * 60_000;

/** How long a program waits for an uncached server's tools before running without them. */
const DISCOVERY_TIMEOUT_MS = 15_000;

export const AddMcpServer = Schema.Struct({
  name: Schema.String,
  transport: Schema.optional(Schema.Literal("http")),
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowedUsers: Schema.optional(Schema.Array(Schema.String)),
});

/** PUT /api/connections/mcp/:name: who may use a server; empty opens it to every session. */
export const McpAccessInput = Schema.Struct({ allowedUsers: Schema.Array(Schema.String) });

const MAX_ALLOWED_USERS = 50;

/**
 * Trimmed, de-duplicated identities (Slack member IDs or GitHub logins, an optional leading @
 * dropped), or an error. Matching is case-insensitive.
 */
export function normalizeAllowedUsers(
  users: readonly string[] | undefined,
): string[] | { error: string } {
  const seen = new Map<string, string>();

  for (const raw of users ?? []) {
    const user = raw.trim().replace(/^@/, "");

    if (!user) continue;

    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(user))
      return { error: `"${raw.trim()}" is not a Slack member ID or GitHub login` };
    seen.set(user.toLowerCase(), user);
  }

  if (seen.size > MAX_ALLOWED_USERS)
    return { error: `At most ${MAX_ALLOWED_USERS} allowed users per server` };

  return [...seen.values()];
}

/**
 * Who a session acts for, for `allowedUsers`: `owner` for the owner's web sessions, otherwise the
 * identities of the person who started it (Slack member ID and linked GitHub login, or the GitHub
 * sender). An empty list matches only unrestricted servers.
 */
export type McpIdentity = "owner" | readonly string[];

/** Whether a session acting for `identity` may use `entry`. */
export function mcpUserAllowed(entry: Pick<McpServerEntry, "allowedUsers">, identity: McpIdentity) {
  if (identity === "owner" || !entry.allowedUsers?.length) return true;
  const allowed = new Set(entry.allowedUsers.map((user) => user.toLowerCase()));

  return identity.some((user) => allowed.has(user.toLowerCase()));
}

/** Which servers a session may use: an automation's list, and who it acts for. */
export type McpScope = { allow?: readonly string[]; identity: McpIdentity };

export const McpTokenInput = Schema.Struct({
  token: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});

/** The `mcp` tool's input: one code mode program (src/mcp-codemode.ts). */
export const McpToolInput = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
});

export const MCP_REFUSAL =
  "MCP servers are not available in this session. Read-only sessions such as automatic reviews never get them, and automation runs may use only the servers their automation lists.";

export const MCP_UNAVAILABLE_PROMPT =
  "MCP servers are not available in this session: read-only sessions never get them, and automation runs get only the servers their automation lists. Don't call the mcp tool here.";

export const mcpToolDescription = MCP_CODE_DESCRIPTION;

const KNOWN_NAMES = new Map([
  ["github", "GitHub"],
  ["posthog", "PostHog"],
  ["workos", "WorkOS"],
  ["incident", "incident.io"],
]);

export function mcpDisplayName(name: string) {
  return (
    KNOWN_NAMES.get(name.toLowerCase()) ??
    name
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function sanitizedTarget(url: string) {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(length: number) {
  return b64url(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// ── Manual token connect ──────────────────────────────────────────────────
// Some providers gate OAuth client registration, but every user can mint an API token. A
// validated pasted token is stored as a grant and rides the same injection path as OAuth.

type Validation = { ok: true } | { ok: false; error: string };

function initializeValidator(url: string, provider: string, rejected: string) {
  return async (token: string): Promise<Validation> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initializeMessage(1)),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    void res.body?.cancel().catch(() => {});

    if (res.status === 401 || res.status === 403) return { ok: false, error: rejected };

    if (!res.ok)
      return { ok: false, error: `Could not check the key with ${provider} (HTTP ${res.status})` };

    return { ok: true };
  };
}

/**
 * Providers whose token is pasted instead of granted by OAuth. Each is bound to the provider's
 * own MCP origin: a server merely named "vercel" elsewhere is never offered, or sent, the token.
 */
const TOKEN_PROVIDERS = new Map<
  string,
  { origin: string; validate: (token: string) => Promise<Validation> }
>([
  [
    "vercel",
    {
      origin: "https://mcp.vercel.com",
      validate: async (token) => {
        const res = await fetch("https://api.vercel.com/v2/user", {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });

        void res.body?.cancel().catch(() => {});

        if (res.status === 401 || res.status === 403)
          return {
            ok: false,
            error:
              "Vercel rejected that token. Create a new one at vercel.com/account/settings/tokens and paste it again.",
          };

        if (!res.ok)
          return { ok: false, error: `Could not check the token with Vercel (HTTP ${res.status})` };

        return { ok: true };
      },
    },
  ],
  [
    "vero",
    {
      origin: "https://api.getvero.com",
      validate: initializeValidator(
        "https://api.getvero.com/mcp",
        "Vero",
        "Vero rejected that key. Create a Campaigns API secret key in Vero and paste it again.",
      ),
    },
  ],
  [
    "oneleet",
    {
      origin: "https://api.oneleet.com",
      validate: initializeValidator(
        "https://api.oneleet.com/mcp",
        "Oneleet",
        "Oneleet rejected that key. Create a service key in Oneleet's workspace settings and paste it again.",
      ),
    },
  ],
]);

/** The token provider for a server, only when its URL is that provider's own HTTPS origin. */
function tokenProvider(name: string, url: string) {
  const provider = TOKEN_PROVIDERS.get(name);

  if (!provider) return undefined;

  try {
    return new URL(url).origin === provider.origin ? provider : undefined;
  } catch {
    return undefined;
  }
}

export function supportsManualToken(name: string, url: string) {
  return tokenProvider(name, url) !== undefined;
}

// ── MCP sessions: the official SDK, in src/mcp-client.ts ──────────────────

/**
 * A bare 2025-era initialize, sent only to check a pasted token: any server answers it, and
 * only the HTTP status matters. Sessions themselves negotiate in src/mcp-client.ts.
 */
function initializeMessage(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Dolly", version: "1" },
    },
  };
}

/** A listed tool, cut to what the catalog and search need. */
function compactTool(tool: ListedTool): CatalogTool {
  const compact: CatalogTool = { name: tool.name };

  if (tool.description) compact.description = tool.description.slice(0, MAX_TOOL_DESCRIPTION);
  const schema = Option.getOrUndefined(decodeJsonObject(tool.inputSchema));

  if (schema && JSON.stringify(schema).length <= MAX_SCHEMA_CHARS) compact.inputSchema = schema;

  return compact;
}

const epochOf = (entry: McpServerEntry) => entry.epoch ?? 0;

/** Whether a server is still the one an operation started on: same add, URL and epoch. */
function unchanged(before: McpServerEntry, after: McpServerEntry | undefined) {
  return (
    after !== undefined &&
    after.id === before.id &&
    after.url === before.url &&
    epochOf(after) === epochOf(before)
  );
}

/**
 * Connections for one owner Durable Object. Storage is the DO's; a request and a refresh in the
 * same object never interleave mid-write, so in-memory de-duplication is enough.
 */
export class McpConnections {
  private statusCache: { data: McpConnection[]; ts: number } | null = null;
  private readonly capable = new Map<string, { capable: boolean; ts: number; soft: boolean }>();
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Tool listings in flight, shared by every program that needs the same server. */
  private readonly listing = new Map<string, Promise<ToolList>>();
  /**
   * Each server's negotiated protocol era (src/mcp-client.ts), by server id, URL and epoch, so
   * only the first session after a start, add or Disconnect probes it. Memory only: a verdict
   * is re-learned after the Durable Object restarts, and dropped if the server stops taking it.
   */
  private readonly eras = new Map<string, PriorDiscovery>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS,
    private readonly programTimeoutMs = CODE_LIMITS.timeoutMs,
  ) {}

  async servers(): Promise<Record<string, McpServerEntry>> {
    return (await this.storage.get<Record<string, McpServerEntry>>(SERVERS_KEY)) ?? {};
  }

  private async writeServers(servers: Record<string, McpServerEntry>) {
    this.statusCache = null;
    await this.storage.put(SERVERS_KEY, servers);
  }

  /**
   * The server and its auth record, only when the record belongs to this very server: same
   * entry id, URL and epoch. A record left by a removed server, one whose URL changed, or one
   * written before a Disconnect is ignored.
   */
  private async current(name: string) {
    const entry = (await this.servers())[name];

    if (!entry) return { entry: undefined, auth: undefined };
    const auth = await this.storage.get<ServerAuth>(authKey(name));

    return {
      entry,
      auth:
        auth &&
        auth.serverId === entry.id &&
        auth.serverUrl === entry.url &&
        auth.epoch === epochOf(entry)
          ? auth
          : undefined,
    };
  }

  async add(input: typeof AddMcpServer.Type): Promise<{ ok: true } | { error: string }> {
    const name = (input.name || "").trim();

    if (!MCP_NAME.test(name))
      return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
    const servers = await this.servers();

    if (servers[name]) return { error: `Server "${name}" already exists — remove it first` };
    let parsed: URL;

    try {
      parsed = new URL(input.url.trim());
    } catch {
      return { error: "Invalid URL" };
    }

    // Servers receive API keys and OAuth tokens: never over plaintext.
    if (parsed.protocol !== "https:") return { error: "URL must use https://" };

    if (parsed.username || parsed.password)
      return { error: "Put credentials in a header, not the URL" };
    const entry: McpServerEntry = { type: "http", id: randomToken(12), url: parsed.href };
    const headers = new Map<string, string>();

    for (const [key, value] of Object.entries(input.headers ?? {})) {
      const header = key.trim();

      if (!header) continue;

      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))
        return { error: `Invalid header name "${header}"` };

      if (/[\r\n]/.test(value)) return { error: `Header "${header}" has a line break` };
      headers.set(header, value.trim());
    }

    if (headers.size) entry.headers = Object.fromEntries(headers);
    const allowedUsers = normalizeAllowedUsers(input.allowedUsers);

    if (!Array.isArray(allowedUsers)) return allowedUsers;

    if (allowedUsers.length) entry.allowedUsers = allowedUsers;
    servers[name] = entry;
    // A record a removed server of this name left behind must never attach to the new one.
    await this.storage.delete([authKey(name), toolsKey(name)]);
    await this.writeServers(servers);

    return { ok: true };
  }

  async remove(name: string): Promise<{ ok: true } | { error: string }> {
    const servers = await this.servers();

    if (!servers[name]) return { error: `Server "${name}" not found` };
    delete servers[name];
    await this.writeServers(servers);
    await this.storage.delete([authKey(name), toolsKey(name)]);

    return { ok: true };
  }

  /** Restrict a server to `users`, or open it to every writable session with an empty list. */
  async setAllowedUsers(
    name: string,
    users: readonly string[],
  ): Promise<{ ok: true; allowedUsers: string[] } | { error: string }> {
    const allowedUsers = normalizeAllowedUsers(users);

    if (!Array.isArray(allowedUsers)) return allowedUsers;
    const servers = await this.servers();
    const entry = servers[name];

    if (!entry) return { error: `Server "${name}" not found` };

    // Only the access list changes: id, URL and epoch stay, so grants and cached tools are kept.
    if (allowedUsers.length) entry.allowedUsers = allowedUsers;
    else delete entry.allowedUsers;
    await this.writeServers(servers);

    return { ok: true, allowedUsers };
  }

  // ── Status ──

  async connections(force = false): Promise<McpConnection[]> {
    if (!force && this.statusCache && Date.now() - this.statusCache.ts < STATUS_TTL_MS)
      return this.statusCache.data;
    const servers = await this.servers();

    const data = await Promise.all(
      Object.entries(servers).map(([name, entry]) => this.check(name, entry)),
    );

    this.statusCache = { data, ts: Date.now() };

    return data;
  }

  private async check(name: string, entry: McpServerEntry): Promise<McpConnection> {
    const base = {
      name,
      transport: "http" as const,
      target: sanitizedTarget(entry.url),
      headerKeys: Object.keys(entry.headers ?? {}),
      allowedUsers: entry.allowedUsers ?? [],
    };

    try {
      // Any HTTP response (incl. 401/405) means the endpoint is up; MCP servers typically
      // reject bare GETs but still answer.
      const res = await fetch(entry.url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(4_000),
      });

      void res.body?.cancel().catch(() => {});

      // Reachable, but an OAuth-protected server with no grant and no static Authorization
      // header isn't usable yet: say "Sign in required" instead of a misleading "Connected".
      if (!hasHeader(entry.headers, "authorization")) {
        const { auth } = await this.current(name);

        if (!auth?.shared) {
          if (supportsManualToken(name, entry.url))
            return {
              ...base,
              status: "needs-auth",
              detail: "API token required. Connect from this card's menu",
            };

          if (await this.oauthCapable(entry.url))
            return {
              ...base,
              status: "needs-auth",
              detail: "OAuth sign-in required — Connect from this card's menu",
            };
        }
      }

      return { ...base, status: "connected", detail: `HTTP ${res.status}` };
    } catch (error) {
      return {
        ...base,
        status: "unreachable",
        detail:
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
            ? "timeout"
            : (error instanceof Error ? error.message : "fetch failed").slice(0, 80),
      };
    }
  }

  private async oauthCapable(serverUrl: string) {
    const hit = this.capable.get(serverUrl);

    if (hit && Date.now() - hit.ts < (hit.soft ? CAPABLE_ERROR_TTL_MS : CAPABLE_TTL_MS))
      return hit.capable;
    let capable = false;
    let soft = false;

    try {
      await discoverMcpOauth(serverUrl);
      capable = true;
    } catch (error) {
      soft = !(error instanceof OauthDiscoveryError) || error.transient;
    }

    this.capable.set(serverUrl, { capable, ts: Date.now(), soft });

    return capable;
  }

  async oauthStatus(name: string): Promise<McpOauthStatus> {
    const { entry, auth } = await this.current(name);

    const status: McpOauthStatus = {
      users: [],
      manualToken: entry !== undefined && supportsManualToken(name, entry.url),
    };

    if (auth?.shared)
      status.shared = { connectedBy: auth.shared.connectedBy, updatedAt: auth.shared.updatedAt };

    return status;
  }

  // ── OAuth ──

  /** A public client for this server and callback: a cached registration, else a new one. */
  private async ensureServerAuth(
    name: string,
    entry: McpServerEntry,
    redirectUri: string,
  ): Promise<ServerAuth> {
    const { auth: current } = await this.current(name);

    if (current?.clientId && current.endpoints.authorize && current.redirectUri === redirectUri)
      return current;

    let discovered;

    try {
      discovered = await discoverMcpOauth(entry.url);
    } catch (error) {
      if (error instanceof OauthDiscoveryError)
        throw new Error(
          `${name} does not advertise OAuth. Add it with an Authorization header instead.`,
          { cause: error },
        );

      throw error;
    }

    const { resource, scopes, endpoints } = discovered;

    if (!endpoints.register)
      throw new Error(`${name}: authorization server offers no dynamic client registration`);
    const clientId = await registerClient(name, endpoints.register, redirectUri);

    // Discovery and registration are network round trips: the server may have been removed,
    // replaced or disconnected meanwhile, and only a fresh read of its record may be kept.
    const { entry: after, auth: fresh } = await this.current(name);

    if (!unchanged(entry, after))
      throw new Error(
        `Server "${name}" changed or was disconnected while connecting. Start again.`,
      );

    const next: ServerAuth = {
      serverId: entry.id,
      epoch: epochOf(entry),
      serverUrl: entry.url,
      redirectUri,
      resource,
      scopes,
      endpoints,
      clientId,
    };

    // A new registration keeps the grant the old one produced until the owner reconnects.
    if (fresh?.shared) next.shared = fresh.shared;

    await this.storage.put(authKey(name), next);

    return next;
  }

  /** Mint the authorize URL for a server. The callback lands on `origin`. */
  async startOauth(name: string, origin: string, connectedBy?: string): Promise<{ url: string }> {
    const entry = (await this.servers())[name];

    if (!entry) throw new Error(`Server "${name}" not found`);
    const redirectUri = `${origin}/api/connections/mcp-oauth/callback`;
    const auth = await this.ensureServerAuth(name, entry, redirectUri);
    const verifier = randomToken(32);
    const challenge = b64url(await sha256(verifier));
    const state = randomToken(24);

    await this.storage.put(pendingKey(state), {
      name,
      serverId: entry.id,
      epoch: epochOf(entry),
      verifier,
      redirectUri,
      connectedBy,
      createdAt: Date.now(),
    } satisfies PendingFlow);

    const url = new URL(auth.endpoints.authorize);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", auth.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    // Request only advertised scopes; when absent, let the server use its defaults.
    if (auth.scopes?.length) url.searchParams.set("scope", auth.scopes.join(" "));
    url.searchParams.set("prompt", "consent");

    if (auth.resource) url.searchParams.set("resource", auth.resource);

    return { url: url.toString() };
  }

  /** Whether a flow still targets the same server, registration and grant epoch. */
  private async flowCurrent(flow: PendingFlow) {
    const { entry, auth } = await this.current(flow.name);

    return entry?.id === flow.serverId && entry && epochOf(entry) === flow.epoch ? auth : undefined;
  }

  /** Complete a flow from the callback redirect. Returns the server that got connected. */
  async completeOauth(state: string, code: string): Promise<{ name: string }> {
    const flow = await this.storage.get<PendingFlow>(pendingKey(state));
    await this.storage.delete(pendingKey(state));

    if (!flow || Date.now() - flow.createdAt > PENDING_TTL_MS)
      throw new Error("This connect link expired. Start again from Connections.");
    const auth = await this.flowCurrent(flow);

    if (!auth)
      throw new Error(
        `${flow.name} was removed or disconnected after this sign-in started. Start again from Connections.`,
      );

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      client_id: auth.clientId,
      code_verifier: flow.verifier,
    });

    if (auth.resource) body.set("resource", auth.resource);

    const response = await fetch(auth.endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    const res = await tokenResponse(response);

    if (!response.ok || !res.access_token)
      throw new Error(
        `Token exchange failed: ${res.error_description || res.error || `HTTP ${response.status}`}`,
      );

    // The exchange yielded: write only if nothing removed, replaced or disconnected the server.
    const fresh = await this.flowCurrent(flow);

    if (!fresh)
      throw new Error(
        `${flow.name} was removed or disconnected while signing in. Start again from Connections.`,
      );
    fresh.shared = grant(res.access_token, res.refresh_token, res.expires_in);

    if (flow.connectedBy) fresh.shared.connectedBy = flow.connectedBy;
    await this.storage.put(authKey(flow.name), fresh);
    this.statusCache = null;

    return { name: flow.name };
  }

  async disconnect(name: string): Promise<boolean> {
    const servers = await this.servers();
    const entry = servers[name];

    if (!entry) return false;
    const { auth } = await this.current(name);
    const had = auth?.shared !== undefined;

    // Every sign-in, registration or token check already running belongs to the old epoch and
    // can no longer write, including a first connection that has no record yet.
    entry.epoch = epochOf(entry) + 1;
    await this.writeServers(servers);

    // The registration stays reusable; only the grant goes.
    if (auth) {
      delete auth.shared;
      auth.epoch = entry.epoch;
      await this.storage.put(authKey(name), auth);
    }

    return had;
  }

  /** Validate a pasted API token live, then store it as the server's grant. */
  async saveToken(name: string, token: string, connectedBy?: string) {
    const entry = (await this.servers())[name];

    if (!entry) throw new Error(`Server "${name}" not found`);
    const provider = tokenProvider(name, entry.url);

    if (!provider)
      throw new Error(
        `${name} has no token connect flow for ${sanitizedTarget(entry.url)}; add the key as a header instead`,
      );
    const checked = await provider.validate(token);

    if (!checked.ok) throw new Error(checked.error);
    // Validation yielded: the server must still be the one the token was checked for.
    const { entry: after, auth } = await this.current(name);

    if (!unchanged(entry, after))
      throw new Error(
        `Server "${name}" changed or was disconnected while checking the token. Start again.`,
      );

    const next: ServerAuth = auth ?? {
      serverId: entry.id,
      epoch: epochOf(entry),
      serverUrl: entry.url,
      redirectUri: "",
      endpoints: { authorize: "", token: "" },
      clientId: "manual-token",
    };

    next.shared = grant(token);

    if (connectedBy) next.shared.connectedBy = connectedBy;
    await this.storage.put(authKey(name), next);
    this.statusCache = null;
  }

  /** The Authorization header for this server, refreshing an expiring token first. */
  private async grantHeader(name: string, entry: McpServerEntry): Promise<string | undefined> {
    let { auth } = await this.current(name);

    if (!auth?.shared) return undefined;

    if (needsRefresh(auth.shared)) {
      await this.refresh(name);
      ({ auth } = await this.current(name));
    }

    // Never send a grant to anything but the server it was issued for.
    if (auth?.serverId !== entry.id || auth.serverUrl !== entry.url) return undefined;
    const stored = auth.shared;

    if (!stored || isExpired(stored)) return undefined;

    return `Bearer ${stored.tokens.accessToken}`;
  }

  private refresh(name: string): Promise<void> {
    const running = this.refreshing.get(name);

    if (running) return running;

    const run = (async () => {
      const { auth } = await this.current(name);
      const stored = auth?.shared;

      if (!auth || !stored?.tokens.refreshToken || !needsRefresh(stored)) return;
      const spent = stored.tokens.refreshToken;

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: spent,
        client_id: auth.clientId,
      });

      if (auth.resource) body.set("resource", auth.resource);

      const response = await fetch(auth.endpoints.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });

      const res = await tokenResponse(response);

      // Provider text could echo the refresh token back, so only the status is reported.
      if (!response.ok || !res.access_token)
        throw new Error(`Token refresh for ${name} failed (HTTP ${response.status})`);
      const { auth: current } = await this.current(name);

      // Removed, replaced, disconnected or reconnected meanwhile: that newer state wins.
      if (
        current?.serverId !== auth.serverId ||
        current.epoch !== auth.epoch ||
        current.shared?.tokens.refreshToken !== spent
      )
        return;
      const next = grant(res.access_token, res.refresh_token || spent, res.expires_in);

      if (current.shared.connectedBy) next.connectedBy = current.shared.connectedBy;
      current.shared = next;
      await this.storage.put(authKey(name), current);
    })()
      .catch((error) =>
        console.error(`[mcp] ${error instanceof Error ? error.message : "token refresh failed"}`),
      )
      .finally(() => this.refreshing.delete(name));

    this.refreshing.set(name, run);

    return run;
  }

  /** Static headers plus the stored grant, which overrides a static Authorization header. */
  private async requestHeaders(name: string, entry: McpServerEntry) {
    // Servers stored before HTTPS was required never receive credentials over plaintext.
    if (new URL(entry.url).protocol !== "https:")
      throw new Error(`${name} uses plain HTTP. Remove it and add it again with an https:// URL.`);
    const headers = { ...entry.headers };
    const grant = await this.grantHeader(name, entry);

    if (grant) {
      for (const key of Object.keys(headers))
        if (key.toLowerCase() === "authorization") delete headers[key];
      headers.Authorization = grant;
    }

    return headers;
  }

  /** Every stored token and header value, for redacting diagnostics. */
  async secrets(): Promise<string[]> {
    const servers = await this.servers();
    const secrets: string[] = [];

    for (const [name, entry] of Object.entries(servers)) {
      secrets.push(...Object.values(entry.headers ?? {}).filter((value) => value.length >= 8));
      const auth = await this.storage.get<ServerAuth>(authKey(name));

      if (auth?.shared) {
        secrets.push(auth.shared.tokens.accessToken);

        if (auth.shared.tokens.refreshToken) secrets.push(auth.shared.tokens.refreshToken);
      }
    }

    return secrets;
  }

  // ── Agent tool: code mode (src/mcp-codemode.ts) ──

  /** An MCP session with a server, reusing (and then updating) its negotiated era. */
  private async open(name: string, entry: McpServerEntry, headers: Record<string, string>) {
    const key = `${entry.id}:${epochOf(entry)}:${entry.url}`;

    try {
      const session: McpSession = await openMcpSession(entry.url, headers, this.eras.get(key), () =>
        this.eras.delete(key),
      );

      this.eras.set(key, session.prior);

      return session;
    } catch (error) {
      this.eras.delete(key);
      throw error;
    }
  }

  /** A cached tool list, only while it still belongs to this server, URL and epoch. */
  private async cachedTools(name: string, entry: McpServerEntry) {
    const cached = await this.storage.get<ToolList>(toolsKey(name));

    return cached &&
      cached.serverId === entry.id &&
      cached.url === entry.url &&
      cached.epoch === epochOf(entry)
      ? cached
      : undefined;
  }

  /** List a server's tools once at a time; concurrent programs share the listing. */
  private listTools(name: string, entry: McpServerEntry) {
    const key = `${name}:${entry.id}:${epochOf(entry)}`;
    const running = this.listing.get(key);

    if (running) return running;

    const run = this.fetchTools(name, entry).finally(() => this.listing.delete(key));
    this.listing.set(key, run);

    return run;
  }

  /**
   * A fresh tools/list over its own MCP session, compacted while reading and bounded in total
   * (MAX_CATALOG_CHARS), so a server can't make the Worker hold its whole catalog: descriptions
   * are cut, oversized schemas dropped, and listing stops at the budget. Cached only if the
   * server is still the one it was read from.
   */
  private async fetchTools(name: string, entry: McpServerEntry): Promise<ToolList> {
    const session = await this.open(name, entry, await this.requestHeaders(name, entry));
    const tools: CatalogTool[] = [];
    const cursors = new Set<string>();
    let chars = 0;
    let cursor: string | undefined;
    let complete = false;

    try {
      // Bounded by pages, total size and count: a server can keep returning pages.
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        // Each page carries the grant: stop as soon as the server is disconnected or changed.
        if (page > 0 && !unchanged(entry, (await this.servers())[name]))
          throw new Error(`${name} was disconnected, removed or changed while listing its tools`);

        const result = await session.listTools(cursor);

        for (const tool of result.tools ?? []) {
          const compact = compactTool(tool);
          chars += JSON.stringify(compact).length;

          if (chars > MAX_CATALOG_CHARS || tools.length >= MAX_TOOLS) break;
          tools.push(compact);
        }

        cursor = result.nextCursor;
        const full = chars > MAX_CATALOG_CHARS || tools.length >= MAX_TOOLS;

        if (cursor === undefined && !full) {
          complete = true;
          break;
        }

        if (cursor === undefined || full || cursors.has(cursor)) break;
        cursors.add(cursor);
      }
    } finally {
      session.close();
    }

    const list: ToolList = {
      serverId: entry.id,
      url: entry.url,
      epoch: epochOf(entry),
      fetchedAt: Date.now(),
      complete,
      tools,
    };

    if (unchanged(entry, (await this.servers())[name]))
      await this.storage.put(toolsKey(name), list);

    return list;
  }

  /**
   * A server's tools for one program, without letting one slow server hold up the rest: a cached
   * list is used at once (and refreshed in the background once stale); an uncached one gets
   * DISCOVERY_TIMEOUT_MS before the program runs without it, while its listing finishes and
   * caches for the next program.
   */
  private async toolsFor(name: string, entry: McpServerEntry): Promise<CatalogTool[]> {
    const cached = await this.cachedTools(name, entry);

    if (cached) {
      if (Date.now() - cached.fetchedAt >= TOOLS_TTL_MS)
        void this.listTools(name, entry).catch(() => {});

      return cached.tools;
    }

    const listing = this.listTools(name, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `still listing tools after ${this.discoveryTimeoutMs / 1000} s; callTool reaches it by exact name`,
            ),
          ),
        this.discoveryTimeoutMs,
      );
    });

    // The listing goes on after a timeout; keep its rejection from going unhandled.
    void listing.catch(() => {});

    try {
      return (await Promise.race([listing, deadline])).tools;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Connected servers the scope may use: those an automation lists (`allow`, when given), and of
   * those only the ones whose `allowedUsers` admit who the session acts for.
   */
  private async allowed(scope: McpScope) {
    const servers = await this.servers();

    return Object.fromEntries(
      Object.entries(servers).filter(
        ([name, entry]) =>
          (!scope.allow || scope.allow.includes(name)) && mcpUserAllowed(entry, scope.identity),
      ),
    );
  }

  /** The system prompt's server list and tool catalog for `scope`. Reads storage only. */
  async promptSection(scope: McpScope = { identity: "owner" }): Promise<string> {
    const servers = await this.allowed(scope);

    if (!Object.keys(servers).length && Object.keys(await this.servers()).length)
      return "No MCP servers are available to this session: Settings > Connections limits who may use the connected ones.";

    if (!Object.keys(servers).length)
      return "No MCP servers are connected. The owner can add them in Settings > Connections, or give you a URL to save with the connections tool.";

    const catalog = await Promise.all(
      Object.entries(servers).map(async ([name, entry]) => {
        const cached = await this.cachedTools(name, entry);

        return {
          name,
          label: `${mcpDisplayName(name)}, ${sanitizedTarget(entry.url)}`,
          tools: cached?.tools,
          complete: cached?.complete ?? false,
        };
      }),
    );

    return catalogPrompt(catalog);
  }

  /** Run one model-written program over the tools of every server `scope` may use. */
  async execute(code: string, scope: McpScope = { identity: "owner" }) {
    const servers = await this.allowed(scope);
    const sessions = new Map<string, Promise<McpSession>>();
    const unavailable = new Map<string, string>();
    const usable = new Map<string, CatalogTool[]>();
    const sent: string[] = [];
    let ended = false;

    // One MCP session per server per run, opened on first use and closed when the run ends.
    const session = (name: string, entry: McpServerEntry) => {
      const open = sessions.get(name);

      if (open) return open;

      const opened = this.requestHeaders(name, entry).then((headers) =>
        this.open(name, entry, headers),
      );

      sessions.set(name, opened);

      return opened;
    };

    try {
      await Promise.all(
        Object.entries(servers).map(async ([name, entry]) => {
          try {
            usable.set(name, await this.toolsFor(name, entry));
          } catch (error) {
            unavailable.set(
              name,
              (error instanceof Error ? error.message : "tools/list failed").slice(0, 200),
            );
          }
        }),
      );

      // Checked right before anything is sent, after every await: a Disconnect, removal or URL
      // change, or the program ending (a timeout), stops the call. Nothing goes out unrecorded.
      const mayCall = async (name: string, entry: McpServerEntry) => {
        const current = (await this.servers())[name];

        // After the storage read, which can itself outlast the program.
        if (ended) throw new Error("The program already ended; this call was not sent");

        if (!unchanged(entry, current))
          throw new Error(
            `${name} was disconnected, removed or changed while this program ran; nothing more was sent to it`,
          );
      };

      const { result, images } = await runCode(
        code,
        usable,
        async (name, tool, args) => {
          const entry = servers[name];

          if (!entry) throw new Error(`No MCP server named "${name}"`);
          await mayCall(name, entry);
          const open = await session(name, entry);

          // Opening the session awaited the network: check again before the call goes out.
          await mayCall(name, entry);
          sent.push(`${name}.${tool}`);

          return open.callTool(
            tool,
            args,
            usable.get(name)?.find((listed) => listed.name === tool),
          );
        },
        this.programTimeoutMs,
      );

      ended = true;

      return resultOutput(result, images, unavailable, sent);
    } finally {
      ended = true;

      for (const opened of sessions.values())
        void opened.then((open) => open.close()).catch(() => {});
    }
  }
}

const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

/** An OAuth token endpoint's JSON body; anything unreadable counts as an empty answer. */
async function tokenResponse(response: Response): Promise<typeof TokenResponse.Type> {
  const text = await response.text().catch(() => "");

  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse))(text),
    () => ({}),
  );
}

function grant(accessToken: string, refreshToken?: string, expiresIn?: number): Grant {
  const tokens: Grant["tokens"] = { accessToken };

  if (refreshToken) tokens.refreshToken = refreshToken;

  if (expiresIn) tokens.expiresAt = Date.now() + expiresIn * 1000;

  return { tokens, updatedAt: new Date().toISOString() };
}

function hasHeader(headers: Record<string, string> | undefined, name: string) {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name);
}

function refreshAheadMs(grant: Grant) {
  const { expiresAt } = grant.tokens;
  const issuedAt = Date.parse(grant.updatedAt);

  if (!expiresAt || !Number.isFinite(issuedAt)) return REFRESH_AHEAD_MS;
  const lifetime = expiresAt - issuedAt;

  return lifetime > 0 ? Math.min(REFRESH_AHEAD_MS, lifetime / 2) : REFRESH_AHEAD_MS;
}

function needsRefresh(grant: Grant) {
  const { expiresAt, refreshToken } = grant.tokens;

  return !!refreshToken && !!expiresAt && expiresAt - Date.now() < refreshAheadMs(grant);
}

function isExpired(grant: Grant) {
  const { expiresAt } = grant.tokens;

  return !!expiresAt && expiresAt < Date.now();
}

/** Dynamic client registration (RFC 7591). Returns the client_id. */
async function registerClient(name: string, register: string, redirectUri: string) {
  const response = await fetch(register, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Dolly",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });

  const text = await response.text();

  if (!response.ok) {
    const host = new URL(register).hostname;

    if (response.status === 403 && host === "api.figma.com")
      throw new Error(
        "Figma does not currently allow Dolly to connect. Its remote MCP server accepts only clients listed in the Figma MCP Catalog.",
      );

    if (response.status === 400 && text.includes("invalid_redirect_uri") && host === "vercel.com")
      throw new Error(
        "Vercel MCP only connects to AI clients Vercel has approved, so it rejects Dolly's callback URL. Use Connect with API token instead.",
      );
    const detail = text.trim().slice(0, 200);

    throw new Error(
      `${name}: client registration failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const decoded = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        client_id: Schema.optional(Schema.String),
        error_description: Schema.optional(Schema.String),
      }),
    ),
  )(text);

  if (Option.isNone(decoded)) throw new Error(`${name}: client registration returned invalid JSON`);
  const registration = decoded.value;

  if (!registration.client_id)
    throw new Error(
      `${name}: client registration failed (${registration.error_description || "no client_id"})`,
    );

  return registration.client_id;
}
