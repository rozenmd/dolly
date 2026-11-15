import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_WEBHOOK_BYTES } from "./github-webhook";
import { MAX_SLACK_BYTES } from "./slack-events";

type Forward = { fetch(request: Request): Promise<Response> };

export const ingress = new Hono<{ Bindings: { INGRESS: Forward; SLACK: Forward } }>();

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

export default ingress;
