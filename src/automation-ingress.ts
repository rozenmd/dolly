import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Effect from "effect/Effect";
import { rpc } from "./operations";
import type { Env } from "./env";

/** Webhook bodies are prompt material, not files; larger requests are refused. */
export const MAX_AUTOMATION_WEBHOOK_BYTES = 64 * 1024;

/** How the ingress Worker passes a webhook's secret on, out of the URL that logs record. */
export const AUTOMATION_SECRET_HEADER = "X-Dolly-Automation-Secret";

/** Headers senders use to name a delivery, so a retried delivery doesn't start a second run. */
const DELIVERY_HEADERS = ["Idempotency-Key", "X-GitHub-Delivery", "X-Request-Id"];

/**
 * A delivery name from the request, or a fresh one when the sender gives none. Any value the
 * sender repeats on a retry names the same delivery: a plain token is used as it is, and anything
 * else (a structured-field string like `"delivery-1"`, or a long value) by its SHA-256.
 */
export async function deliveryOf(headers: Headers) {
  for (const name of DELIVERY_HEADERS) {
    const value = headers.get(name)?.trim();

    if (!value) continue;
    // A structured-field string is its contents: `"delivery-1"` and `delivery-1` are one key.
    const token = /^"(.*)"$/.exec(value)?.[1] ?? value;

    if (/^[\w.:-]{1,200}$/.test(token)) return token;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

    return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  return crypto.randomUUID();
}

/**
 * Only this named entrypoint is bound to the public ingress Worker for automation webhooks
 * (automations.ts). The secret, which the ingress Worker moves from the URL into a header, is the
 * only credential; the Agent checks it.
 */
export class AutomationIngress extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const app = new Hono();

    app.use("*", async (c, next) => {
      const headers = new Headers(c.req.raw.headers);
      headers.delete("Content-Length");
      c.req.raw = new Request(c.req.raw, { headers });
      await next();
    });
    app.use("*", bodyLimit({ maxSize: MAX_AUTOMATION_WEBHOOK_BYTES }));
    app.post("/hooks/automations/:id", async (c) => {
      const secret = c.req.header(AUTOMATION_SECRET_HEADER);

      if (!secret) return c.text("Not found", 404);
      const payload = new TextDecoder().decode(await c.req.arrayBuffer());
      const delivery = await deliveryOf(c.req.raw.headers);

      const result = await Effect.runPromise(
        rpc(
          "automations.webhook",
          async () =>
            await this.env.AGENT.getByName("owner").automationWebhook(
              c.req.param("id"),
              secret,
              payload,
              delivery,
            ),
        ),
      );

      const { status, ...body } = result;

      return c.json(body, status);
    });
    app.notFound(() => new Response("Not found", { status: 404 }));

    return app.fetch(request);
  }
}
