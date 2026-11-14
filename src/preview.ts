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
