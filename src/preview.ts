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
    waitFor: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
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
  waitFor: Schema.optional(Schema.String),
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

export function previewRequest(request: Request, hostname: string) {
  const url = new URL(request.url);

  if (url.protocol !== "http:" || url.hostname !== hostname || url.port) return null;

  // Never give repository code the application's credentials.
  const headers = new Headers(request.headers);

  const credentials = Array.from(headers.keys()).filter((name) =>
    /^(cookie|authorization|cf-access-.*)$/i.test(name),
  );

  for (const name of credentials) headers.delete(name);

  return new Request(request, { headers });
}

/** A scoped capability passed to Browser Run, never mounted on a public route. */
export class PreviewOutbound extends WorkerEntrypoint<Env, PreviewRoute> {
  async fetch(request: Request) {
    const forwarded = previewRequest(request, this.ctx.props.hostname);

    if (!forwarded) return new Response("Not found", { status: 404 });

    return this.env.SANDBOX.getByName(this.ctx.props.sandboxId).previewFetch(
      forwarded,
      this.ctx.props.token,
    );
  }
}
