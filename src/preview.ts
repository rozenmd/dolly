import { WorkerEntrypoint } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import type { Env } from "./env";

export const PREVIEW_TTL_MS = 15 * 60 * 1000;
export const PreviewPort = Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 }));

export const PreviewPath = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((path) => {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\p{Cc}]/u.test(path)) return false;

    return new URL(path, "http://preview.test").origin === "http://preview.test";
  }),
);

const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 2560 }));

/** Device pixels per CSS pixel; width and height stay in CSS pixels. */
const Scale = Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3 }));

const Selector = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Most actions a screenshot may run, and the longest single wait action. */
export const MAX_PREVIEW_ACTIONS = 10;
export const MAX_PREVIEW_WAIT_MS = 5_000;

/** Keys press accepts: named keys, or one printable character. */
export const PREVIEW_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

const Key = Schema.String.check(
  Schema.makeFilter(
    (key) => PREVIEW_KEYS.some((name) => name === key) || /^[\x21-\x7e]$/.test(key),
  ),
);

export const PreviewAction = Schema.Union([
  Schema.Struct({ click: Selector }),
  Schema.Struct({
    type: Schema.Struct({
      selector: Selector,
      text: Schema.String.check(Schema.isMaxLength(2000)),
    }),
  }),
  Schema.Struct({ press: Key }),
  Schema.Struct({ waitFor: Selector }),
  Schema.Struct({
    wait: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_PREVIEW_WAIT_MS })),
  }),
]);

export type PreviewAction = typeof PreviewAction.Type;

const Actions = Schema.Array(PreviewAction).check(Schema.isMaxLength(MAX_PREVIEW_ACTIONS));

export const PreviewRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("start"),
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
    port: PreviewPort,
  }),
  Schema.Struct({
    action: Schema.Literal("screenshot"),
    path: Schema.optional(PreviewPath),
    width: Schema.optional(Dimension),
    height: Schema.optional(Dimension),
    scale: Schema.optional(Scale),
    waitFor: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
    actions: Schema.optional(Actions),
  }),
  Schema.Struct({ action: Schema.Literals(["status", "stop"]) }),
]);

export const PreviewToolInput = Schema.Struct({
  action: Schema.Literals(["start", "screenshot", "status", "stop"]),
  command: Schema.optional(Schema.String),
  port: Schema.optional(PreviewPort),
  path: Schema.optional(PreviewPath),
  width: Schema.optional(Dimension),
  height: Schema.optional(Dimension),
  scale: Schema.optional(Scale),
  waitFor: Schema.optional(Schema.String),
  actions: Schema.optional(Actions),
});

/** How long start waits before returning a still-starting server. */
export const PREVIEW_START_WAIT_MS = 30_000;

/** How long screenshot waits for a still-starting server to answer. */
export const PREVIEW_SCREENSHOT_WAIT_MS = 60_000;

export type PreviewEnd = "stopped" | "exited" | "failed" | "restarted";

/** The last preview this sandbox started, kept in storage so a restarted DO can explain it. */
export type PreviewRecord = {
  port: number;
  startedAt: number;
  expiresAt: number;
  endedAt?: number;
  ended?: PreviewEnd;
};

/** What preview status reports; message explains a missing preview, hints a silent one. */
export type PreviewStatus = {
  running: boolean;
  ready: boolean;
  state: "ready" | "starting" | "stopped";
  port?: number;
  startedAt?: number;
  expiresAt?: number;
  message?: string;
  hints?: string[];
  logs: string;
};

export const PREVIEW_RECORD_KEY = "preview:last";

const iso = (time: number) => new Date(time).toISOString();

/** Why there is no live preview, phrased as what to do next. */
export function previewUnavailable(record: PreviewRecord | undefined, now = Date.now()) {
  if (!record) return "No preview has been started in this sandbox; use preview start first";
  const started = `the preview on port ${record.port} started at ${iso(record.startedAt)}`;

  switch (record.ended) {
    case "stopped":
      return `Preview on port ${record.port} was stopped at ${iso(record.endedAt ?? now)}; use preview start again`;
    case "exited":
      return `Dev server on port ${record.port} exited at ${iso(record.endedAt ?? now)}; check preview status logs, then use preview start again`;
    case "failed":
      return `The last preview start on port ${record.port} failed at ${iso(record.endedAt ?? now)}; check preview status logs, then use preview start again`;
    case "restarted":
      return `The sandbox restarted at ${iso(record.endedAt ?? now)}, which ended ${started}; use preview start again`;
  }

  if (record.expiresAt <= now)
    return `Preview on port ${record.port} expired at ${iso(record.expiresAt)} (previews last ${PREVIEW_TTL_MS / 60_000} minutes); use preview start again`;

  return `The sandbox restarted since ${started}, so it is no longer running; use preview start again`;
}

/** The last lines of a dev-server log, for errors that would otherwise say only "check logs". */
export function logTail(logs: string, lines = 20, chars = 2000) {
  const tail = logs.trimEnd().split("\n").slice(-lines).join("\n");

  return tail.length > chars ? tail.slice(-chars) : tail;
}

/** Hints for a server that runs but never answers on the requested port. */
export function readinessHints(logs: string, port: number) {
  const hints: string[] = [];
  const ports = new Set<number>();
  let loopbackOnly = false;

  for (const match of logs.matchAll(/\bhttps?:\/\/([\w.[\]:-]+?):(\d{2,5})\b/g)) {
    const found = Number(match[2]);

    if (found !== port && found >= 1024) ports.add(found);

    if (found === port && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(match[1])) loopbackOnly = true;
  }

  if (ports.size)
    hints.push(
      `the logs mention port ${[...ports].join(", ")}, not ${port}: if the server picked another port, stop and start with that port`,
    );

  if (loopbackOnly && !/0\.0\.0\.0/.test(logs))
    hints.push(
      "if the server listens on localhost only, bind it to 0.0.0.0 (for example --host 0.0.0.0 or -H 0.0.0.0)",
    );

  return hints;
}

export type PreviewRoute = { sandboxId: string; token: string; hostname: string };

export const isWebSocketUpgrade = (request: Request) =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

/**
 * Workers RPC cannot return a WebSocket, so upgrades reach the sandbox through its fetch
 * handler instead, carrying the same capability as the RPC call in one of these headers.
 */
export const PREVIEW_TOKEN_HEADER = "X-Dolly-Preview-Token";
export const BROWSER_PORT_HEADER = "X-Dolly-Browser-Port";

const INTERNAL_HEADERS = /^(authorization|cf-access-.*|x-dolly-.*)$/i;

/**
 * Cookie name prefixes a browser accepts only from a secure origin, and the names the plain-http
 * preview origin stores them under instead. The proxy renames them back on the way in.
 */
const COOKIE_PREFIXES = [
  ["__Host-", "dolly-host--"],
  ["__Secure-", "dolly-secure--"],
] as const;

/** Restore cookie names the preview renamed, so the dev server sees the names it set. */
export function previewCookie(header: string) {
  return header
    .split(";")
    .map((part) => {
      const cookie = part.trim();

      for (const [prefix, stored] of COOKIE_PREFIXES)
        if (cookie.toLowerCase().startsWith(stored)) return prefix + cookie.slice(stored.length);

      return cookie;
    })
    .filter(Boolean)
    .join("; ");
}

/**
 * Make a dev server's Set-Cookie stick on the plain-http, single-host preview origin: drop
 * Secure, Partitioned and Domain (so the cookie stays host-only), relax SameSite=None (which
 * requires Secure) to Lax, and store __Host-/__Secure- names under names http may set.
 */
export function previewSetCookie(cookie: string) {
  const [pair = "", ...attributes] = cookie.split(";");
  const equals = pair.indexOf("=");
  let name = equals < 0 ? "" : pair.slice(0, equals).trim();
  const value = equals < 0 ? pair.trim() : pair.slice(equals + 1).trim();

  for (const [prefix, stored] of COOKIE_PREFIXES)
    if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
      name = stored + name.slice(prefix.length);
      break;
    }

  const kept = attributes.flatMap((attribute) => {
    const trimmed = attribute.trim();
    const key = trimmed.split("=")[0].trim().toLowerCase();

    if (!trimmed || key === "secure" || key === "partitioned" || key === "domain") return [];

    if (key === "samesite" && /^samesite\s*=\s*none$/i.test(trimmed)) return ["SameSite=Lax"];

    return [trimmed];
  });

  return [equals < 0 ? value : `${name}=${value}`, ...kept].join("; ");
}

/** Rewrite a dev server's response cookies for the preview origin; upgrades pass unchanged. */
export function previewResponse(response: Response) {
  const cookies = response.headers.getSetCookie();

  if (!cookies.length || response.webSocket) return response;
  const rewritten = new Response(response.body, response);
  rewritten.headers.delete("Set-Cookie");

  for (const cookie of cookies) rewritten.headers.append("Set-Cookie", previewSetCookie(cookie));

  return rewritten;
}

/**
 * Pin a browser request to one hostname, without the application's credentials or forged
 * capabilities. Cookies pass: each preview is a fresh Browser Run session on its own host, so
 * the only cookies it can hold for that host are ones the dev server (or its page) set.
 */
export function previewRequest(request: Request, hostname: string) {
  const url = new URL(request.url);
  const upgrade = isWebSocketUpgrade(request);

  if (!(url.protocol === "http:" || (upgrade && url.protocol === "ws:"))) return null;

  if (url.hostname !== hostname || url.port || url.username || url.password) return null;

  // Never give repository code the application's credentials, nor let a page forge a capability.
  const headers = new Headers(request.headers);

  for (const name of Array.from(headers.keys()).filter((name) => INTERNAL_HEADERS.test(name)))
    headers.delete(name);
  const cookie = headers.get("Cookie");

  if (cookie !== null) headers.set("Cookie", previewCookie(cookie));

  if (url.protocol === "http:") return new Request(request, { headers });
  url.protocol = "http:";

  return new Request(url, { method: request.method, headers, redirect: "manual" });
}

/**
 * A page's own Origin and Referer, rewritten from the preview origin to the origin the dev
 * server sees, so its same-origin checks (WebSocket Origin guards, CSRF) pass. Others are kept.
 */
export function localOrigin(headers: Headers, from: string, to: string) {
  if (headers.get("Origin") === from) headers.set("Origin", to);
  const referer = headers.get("Referer");

  if (referer !== null && (referer === from || referer.startsWith(`${from}/`)))
    headers.set("Referer", to + referer.slice(from.length));
}

/** Add a sandbox capability header to an upgrade bound for the sandbox's fetch handler. */
export function sandboxUpgrade(request: Request, header: string, value: string) {
  const headers = new Headers(request.headers);
  headers.set(header, value);

  return new Request(request, { headers });
}

/** A scoped capability passed to Browser Run, never mounted on a public route. */
export class PreviewOutbound extends WorkerEntrypoint<Env, PreviewRoute> {
  async fetch(request: Request) {
    const forwarded = previewRequest(request, this.ctx.props.hostname);

    if (!forwarded) return new Response("Not found", { status: 404 });
    const sandbox = this.env.SANDBOX.getByName(this.ctx.props.sandboxId);

    if (isWebSocketUpgrade(forwarded))
      return sandbox.fetch(sandboxUpgrade(forwarded, PREVIEW_TOKEN_HEADER, this.ctx.props.token));

    return previewResponse(await sandbox.previewFetch(forwarded, this.ctx.props.token));
  }
}
