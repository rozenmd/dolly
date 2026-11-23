import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_WEBHOOK_BYTES } from "./github-webhook";
import { MAX_SLACK_BYTES } from "./slack-events";
import { AUTOMATION_SECRET_HEADER, MAX_AUTOMATION_WEBHOOK_BYTES } from "./automation-ingress";

type Forward = { fetch(request: Request): Promise<Response> };

export const ingress = new Hono<{
  Bindings: { INGRESS: Forward; SLACK: Forward; AUTOMATIONS: Forward };
}>();

ingress.use("*", async (c, next) => {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("Content-Length");
  c.req.raw = new Request(c.req.raw, { headers });
  await next();
});

ingress.post("/hooks/github", bodyLimit({ maxSize: MAX_WEBHOOK_BYTES }), (c) =>
  c.env.INGRESS.fetch(c.req.raw),
);

ingress.post("/slack/events", bodyLimit({ maxSize: MAX_SLACK_BYTES }), (c) =>
  c.env.SLACK.fetch(c.req.raw),
);

ingress.post("/slack/actions", bodyLimit({ maxSize: MAX_SLACK_BYTES }), (c) =>
  c.env.SLACK.fetch(c.req.raw),
);

/**
 * An automation's webhook: the secret is the `secret` query parameter, which this Worker's logs
 * and traces redact (ingress/cloudflare.config.ts). It goes on to `dolly` in a header, with the
 * query removed, so no log on either Worker records it.
 */
ingress.post(
  "/hooks/automations/:id",
  bodyLimit({ maxSize: MAX_AUTOMATION_WEBHOOK_BYTES }),
  (c) => {
    const secret = c.req.query("secret");

    if (!secret) return c.text("Not found", 404);
    const url = new URL(c.req.url);
    url.search = "";
    const headers = new Headers(c.req.raw.headers);
    headers.set(AUTOMATION_SECRET_HEADER, secret);

    return c.env.AUTOMATIONS.fetch(
      new Request(url, { method: "POST", headers, body: c.req.raw.body }),
    );
  },
);

export default ingress;
