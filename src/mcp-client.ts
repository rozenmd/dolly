/**
 * Dolly's MCP client: the official TypeScript SDK (`@modelcontextprotocol/client`) over
 * Streamable HTTP, wrapped so a remote server can't hurt the owner Durable Object.
 *
 * The SDK negotiates the protocol revision (`versionNegotiation: "auto"`): a 2026-07-28 server
 * is spoken to in the modern era, and anything else falls back to the 2025 `initialize`
 * handshake. A probe that times out is retried once as legacy, as opencode does, because some
 * slow legacy servers never answer `server/discover`. The verdict is handed back so the caller
 * can skip the probe next time (`prior`).
 *
 * Every request goes through `guardedFetch`, which keeps the guarantees the hand-written client
 * had: redirects are never followed (requests carry the owner's credentials), each request has a
 * deadline, and no response body may exceed MAX_RESPONSE_BYTES, counted across a whole SSE
 * stream. Sessions are one-shot: a program or a listing opens one, uses it and closes it, so the
 * standalone GET stream for server-initiated messages is never opened.
 */
import {
  Client,
  type PriorDiscovery,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { JsonObject } from "./mcp-codemode";

export type { PriorDiscovery };

/** Bytes read from one MCP response before giving up, so a server cannot exhaust the DO. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Deadline for one HTTP request to the server, including reading an SSE response to its end. */
const REQUEST_TIMEOUT_MS = 60_000;

/** How long the `server/discover` probe may take before the server is treated as legacy. */
const PROBE_TIMEOUT_MS = 10_000;

const TOO_LARGE = `MCP server response exceeded ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB`;

/**
 * Sent when the owner's static headers don't set one. Workers' fetch sends no User-Agent at all,
 * and bot protection in front of some MCP servers answers such requests with HTTP 403.
 */
export const MCP_USER_AGENT = "Dolly-MCP-Client/1";

/** `headers` plus Dolly's User-Agent, unless they already carry one (in any casing). */
export function withUserAgent(headers?: HeadersInit) {
  const merged = new Headers(headers);

  if (!merged.has("user-agent")) merged.set("user-agent", MCP_USER_AGENT);

  return merged;
}

export class McpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const ToolsPage = Schema.Struct({
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optional(Schema.String),
        inputSchema: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
  nextCursor: Schema.optional(Schema.String),
});

export type ListedTool = NonNullable<typeof ToolsPage.Type.tools>[number];

const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: Schema.Struct({
      uri: Schema.optional(Schema.String),
      mimeType: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("resource_link"),
    uri: Schema.String,
    name: Schema.optional(Schema.String),
  }),
  // Audio, and block types newer than this client.
  Schema.Struct({ type: Schema.String }),
]);

export const CallToolResult = Schema.Struct({
  content: Schema.optional(Schema.Array(ContentBlock)),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});

/**
 * Pages are decoded leniently, by Dolly's own schema rather than the SDK's: one malformed tool
 * should cost that tool, not the server's whole catalog.
 */
const ToolsPageStandard = Schema.toStandardSchemaV1(ToolsPage);

/** A response whose body errors, and calls `overflow`, once more than MAX_RESPONSE_BYTES were read. */
function bounded(response: Response, overflow: () => void) {
  if (!response.body) return response;
  let size = 0;

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;

        if (size <= MAX_RESPONSE_BYTES) return controller.enqueue(chunk);
        controller.error(new Error(TOO_LARGE));
        overflow();
      },
    }),
  );

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * fetch for the SDK transport: no redirects, a deadline per request, bounded bodies, and no
 * standalone GET stream (answered as a server without one, 405, which the SDK accepts).
 */
function guardedFetch(overflow: () => void) {
  return async (input: string | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "GET")
      return new Response(null, { status: 405, statusText: "Method Not Allowed" });
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    const response = await fetch(input, {
      ...init,
      headers: withUserAgent(init?.headers),
      redirect: "manual",
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });

    return bounded(response, overflow);
  };
}

/** The error to show for one the SDK threw: refused credentials say how to fix them. */
function explain(cause: unknown) {
  if (cause instanceof SdkHttpError && (cause.status === 401 || cause.status === 403))
    return new McpHttpError(
      `MCP server refused the credentials (HTTP ${cause.status}); reconnect it in Settings > Connections`,
      cause.status,
    );

  if (cause instanceof SdkHttpError)
    return new McpHttpError(`MCP server answered HTTP ${cause.status}`, cause.status);

  return cause instanceof Error ? cause : new Error(String(cause));
}

/** An open MCP session: requests share its connection until close. */
export interface McpSession {
  /** "modern" for a 2026-07-28 (or later) server, "legacy" for the 2025 handshake. */
  readonly era: "modern" | "legacy";
  /** The verdict to pass as `prior` next time, so the probe is skipped. */
  readonly prior: PriorDiscovery;
  /** One tools/list page. */
  listTools(cursor?: string): Promise<typeof ToolsPage.Type>;
  /**
   * tools/call. `definition` is the tool as listed, used by the SDK to mirror arguments into
   * headers on modern servers; output schemas are never enforced, since servers often return
   * results that miss their own schema.
   */
  callTool(
    name: string,
    args: JsonObject,
    definition?: { inputSchema?: JsonObject },
  ): Promise<typeof CallToolResult.Type>;
  close(): void;
}

function newClient() {
  return new Client(
    { name: "Dolly", version: "1" },
    {
      capabilities: {},
      versionNegotiation: { mode: "auto", probe: { timeoutMs: PROBE_TIMEOUT_MS } },
      // A modern server that answers `input_required` gets an error, never a continuation the
      // SDK sends on its own: every tools/call must pass Dolly's Disconnect and program checks
      // (src/mcp.ts) right before it goes out, and Dolly has no input to give anyway.
      inputRequired: { autoFulfill: false },
    },
  );
}

/**
 * A connected client. A response over the size bound closes it, which fails whatever is waiting
 * on it at once (a stream cut short would otherwise leave its request waiting for a deadline);
 * `overflowed` then tells callers why.
 */
async function connect(url: string, headers: Record<string, string>, prior?: PriorDiscovery) {
  const state = { overflowed: false };
  const client = newClient();

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers, redirect: "manual" },
    fetch: guardedFetch(() => {
      state.overflowed = true;
      void client.close().catch(() => {});
    }),
    // Redirects are left to fetch, which guardedFetch never lets follow one: requests carry
    // credentials, so even a same-origin redirect is refused.
    redirectPolicy: "follow",
    // A dropped response stream is an error for the caller, not something to resume.
    reconnectionOptions: {
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });

  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS, prior });
  } catch (error) {
    void client.close().catch(() => {});
    throw state.overflowed ? new Error(TOO_LARGE) : error;
  }

  return { client, transport, state };
}

const RejectedEra = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literal(ProtocolErrorCode.UnsupportedProtocolVersion) }),
  }),
);

/**
 * Whether the server refused the session's protocol revision (-32022): as a JSON-RPC error the
 * SDK matched to the request, or in the body of the HTTP 400 when it couldn't (no request id).
 */
function rejectsEra(cause: unknown): cause is Error {
  if (cause instanceof ProtocolError)
    return cause.code === ProtocolErrorCode.UnsupportedProtocolVersion;

  return (
    cause instanceof SdkHttpError &&
    cause.status === 400 &&
    Option.isSome(Schema.decodeUnknownOption(RejectedEra)(cause.data.text))
  );
}

/**
 * Whether a failed auto negotiation should be retried once with the plain 2025 handshake: the
 * probe timed out (some slow legacy servers never answer `server/discover`), or the server
 * answered HTTP 403. The SDK treats a 403 to the probe as final, but some legacy servers and
 * the gateways in front of them refuse the unknown method or its 2026 MCP-Protocol-Version
 * header that way while accepting `initialize`; a real denial just fails the retry too.
 */
function retryAsLegacy(cause: unknown): cause is SdkError {
  if (cause instanceof SdkHttpError) return cause.status === 403;

  return cause instanceof SdkError && cause.code === SdkErrorCode.RequestTimeout;
}

/**
 * Open a session with the server at `url`. `prior` is an earlier session's verdict: it skips
 * the probe, and is dropped (one fresh negotiation) if the server no longer accepts it. The SDK
 * adopts a modern `prior` without asking the server, so a server rolled back to 2025 only says so
 * on a later request (-32022 UnsupportedProtocolVersion): `forget` is then called, so the caller
 * stops handing out the stale verdict and the next session negotiates afresh.
 */
export async function openMcpSession(
  url: string,
  headers: Record<string, string>,
  prior?: PriorDiscovery,
  forget?: () => void,
): Promise<McpSession> {
  let opened: Awaited<ReturnType<typeof connect>>;

  try {
    opened = await connect(url, headers, prior).catch(async (error) => {
      if (prior) return connect(url, headers);

      if (retryAsLegacy(error)) return connect(url, headers, { kind: "legacy" });
      throw error;
    });
  } catch (error) {
    throw explain(error);
  }

  const { client, transport, state } = opened;

  const failure = (cause: unknown) => {
    if (rejectsEra(cause)) forget?.();

    return state.overflowed ? new Error(TOO_LARGE) : explain(cause);
  };

  const discover = client.getDiscoverResult();
  const era = client.getProtocolEra() === "modern" ? "modern" : "legacy";

  return {
    era,
    prior: era === "modern" && discover ? { kind: "modern", discover } : { kind: "legacy" },

    async listTools(cursor) {
      try {
        return await client.request(
          { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
          ToolsPageStandard,
          { timeout: REQUEST_TIMEOUT_MS },
        );
      } catch (error) {
        throw failure(error);
      }
    },

    async callTool(name, args, definition) {
      let result: unknown;

      try {
        result = await client.callTool(
          { name, arguments: args },
          {
            timeout: REQUEST_TIMEOUT_MS,
            toolDefinition: {
              name,
              inputSchema: { type: "object", ...definition?.inputSchema },
            },
          },
        );
      } catch (error) {
        throw failure(error);
      }

      const decoded = Schema.decodeUnknownOption(CallToolResult)(result);

      if (Option.isNone(decoded))
        throw new Error("MCP server returned an invalid tools/call result");

      return decoded.value;
    },

    close() {
      // Ends a legacy session on the server too (DELETE with its id); modern servers have none.
      void (transport.sessionId ? transport.terminateSession() : Promise.resolve())
        .catch(() => {})
        .finally(() => void client.close().catch(() => {}));
    },
  };
}
