/**
 * OAuth discovery for remote MCP servers, ported from Opensession's mcp-oauth-discovery.ts:
 * RFC 9728 protected-resource metadata for the server resource, then RFC 8414 / OIDC
 * authorization-server metadata. No credentials, redirects or recursive discovery, bounded
 * bodies, and one deadline for the whole lookup.
 *
 * Differences from Opensession: a Worker has no DNS lookup to vet private addresses with, so a
 * metadata URL on another origin must simply be HTTPS (the configured origin is already trusted).
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface OauthDiscovery {
  resource?: string;
  scopes?: string[];
  endpoints: { authorize: string; token: string; register?: string };
  /** The AS accepts an HTTPS URL as client_id (Client ID Metadata Documents). */
  clientIdMetadataDocument?: true;
}

/** A definitive absence can be cached; transport failures must be retried soon. */
export class OauthDiscoveryError extends Error {
  constructor(readonly transient: boolean) {
    super("No valid OAuth authorization-server metadata for this MCP resource");
  }
}

const MAX_METADATA_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

/** OAuth endpoints receive codes, verifiers and tokens, so every one must be HTTPS. */
function discoveryUrl(raw: string, resource: URL): URL {
  if (raw.length > 4096) throw new Error("Invalid OAuth metadata URL");
  const url = new URL(raw);

  if (
    url.protocol !== "https:" ||
    resource.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Unsafe OAuth metadata URL");

  return url;
}

/** RFC 9728 protected-resource metadata, as far as discovery needs it. */
const ProtectedResource = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.NonEmptyArray(Schema.String),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});

/** RFC 8414 authorization-server metadata, as far as discovery needs it. */
const AuthorizationServer = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
});

/** A bounded JSON metadata body decoded with `schema`; invalid documents throw. */
async function metadata<A, I>(response: Response, schema: Schema.Codec<A, I>): Promise<A> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error("OAuth metadata unavailable");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read().catch(() => {
        throw new OauthDiscoveryError(true);
      });

      if (done) break;
      size += value.length;

      if (size > MAX_METADATA_BYTES) throw new Error("OAuth metadata too large");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(
    new TextDecoder().decode(bytes),
  );

  if (Option.isNone(decoded)) throw new Error("Invalid OAuth metadata");

  return decoded.value;
}

/** Only Bearer challenges may supply resource_metadata. Split on commas outside quoted strings
 * so a Basic realm cannot smuggle a discovery parameter. */
function challengeMetadata(header: string): string | undefined {
  if (header.length > 8192) return undefined;
  let bearer = false;

  for (const part of header.match(/(?:[^,"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? []) {
    const challenge = part.trim().match(/^([\w-]+)\s+(?![=\s])(.*)$/);
    const param = challenge ? challenge[2]! : part.trim();

    if (challenge) bearer = challenge[1]!.toLowerCase() === "bearer";
    const match = param.match(/^resource_metadata\s*=\s*"([^"\\]*)"\s*$/i);

    if (bearer && match) return match[1];
  }

  return undefined;
}

/** RFC 9728 binds the document to the requested resource. Like the MCP SDK, also accept a
 * same-origin parent path, but never a sibling path, a longer path, or one with a query. */
function coversResource(raw: string, requested: URL): boolean {
  const advertised = new URL(raw);

  if (advertised.href === requested.href) return true;

  if (advertised.origin !== requested.origin || advertised.search || advertised.hash) return false;
  const slash = (path: string) => (path.endsWith("/") ? path : `${path}/`);

  return (
    advertised.pathname.length <= requested.pathname.length &&
    slash(requested.pathname).startsWith(slash(advertised.pathname))
  );
}

function wellKnown(issuer: URL, name: string): string[] {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");

  return [
    `${issuer.origin}/.well-known/${name}${path}`,
    `${issuer.origin}${path}/.well-known/${name}`,
  ];
}

export async function discoverMcpOauth(serverUrl: string): Promise<OauthDiscovery> {
  const resourceUrl = new URL(serverUrl);
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  let transient = false;

  /** Whether this lookup may succeed later: a timeout or a transport failure. */
  const noteFailure = (transportFailure: boolean) => {
    transient ||= signal.aborted || transportFailure;
  };

  const request = async (raw: string) => {
    signal.throwIfAborted();
    const url = discoveryUrl(raw, resourceUrl);

    const response = await fetch(url.href, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal,
    }).catch(() => {
      throw new OauthDiscoveryError(true);
    });

    if (response.status === 408 || response.status === 429 || response.status >= 500)
      transient = true;

    return response;
  };

  // Validate the configured target too (notably userinfo, fragments and schemes).
  discoveryUrl(serverUrl, resourceUrl);
  let advertised: string | undefined;

  try {
    const response = await request(serverUrl);

    if (response.status === 401)
      advertised = challengeMetadata(response.headers.get("www-authenticate") ?? "");
    void response.body?.cancel().catch(() => {});
  } catch (error) {
    noteFailure(error instanceof OauthDiscoveryError && error.transient);
  }

  const path = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname;

  const candidates = new Set([
    ...(advertised ? [advertised] : []),
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${path}`,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
  ]);

  let resource: string | undefined;
  let scopes: string[] | undefined;
  let issuer = resourceUrl.origin;

  for (const candidate of candidates) {
    try {
      const pr = await metadata(await request(candidate), ProtectedResource);

      if (!coversResource(pr.resource, resourceUrl)) continue;
      const nextIssuer = discoveryUrl(pr.authorization_servers[0], resourceUrl);

      if (nextIssuer.search) continue;
      resource = pr.resource;
      scopes = pr.scopes_supported && [...pr.scopes_supported];
      issuer = pr.authorization_servers[0];
      break;
    } catch (error) {
      noteFailure(error instanceof OauthDiscoveryError && error.transient);
    }
  }

  // Keep legacy origin-only AS discovery for servers without RFC 9728 metadata.
  const asCandidates = new Set([
    ...wellKnown(new URL(issuer), "oauth-authorization-server"),
    // OIDC's standard form appends to the issuer path; also support insertion.
    ...wellKnown(new URL(issuer), "openid-configuration").reverse(),
  ]);

  for (const candidate of asCandidates) {
    try {
      const as = await metadata(await request(candidate), AuthorizationServer);

      // Advertised issuers must match exactly. For the legacy origin guess, accept the root
      // slash that URL serialization inserts.
      if (resource ? as.issuer !== issuer : new URL(as.issuer).href !== new URL(issuer).href)
        continue;

      const discovery: OauthDiscovery = {
        resource,
        scopes,
        endpoints: {
          authorize: discoveryUrl(as.authorization_endpoint, resourceUrl).href,
          token: discoveryUrl(as.token_endpoint, resourceUrl).href,
        },
      };

      if (as.registration_endpoint !== undefined)
        discovery.endpoints.register = discoveryUrl(as.registration_endpoint, resourceUrl).href;

      if (as.client_id_metadata_document_supported === true)
        discovery.clientIdMetadataDocument = true;

      return discovery;
    } catch (error) {
      noteFailure(error instanceof OauthDiscoveryError && error.transient);
    }
  }

  throw new OauthDiscoveryError(transient);
}
