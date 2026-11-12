import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_WEBHOOK_BYTES } from "./github-webhook";

export const ingress = new Hono<{
  Bindings: { INGRESS: { fetch(request: Request): Promise<Response> } };
}>();

ingress.use("*", async (c, next) => {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("Content-Length");
  c.req.raw = new Request(c.req.raw, { headers });
  await next();
});

ingress.use("*", bodyLimit({ maxSize: MAX_WEBHOOK_BYTES }));

ingress.post("/hooks/github", (c) => c.env.INGRESS.fetch(c.req.raw));

export default ingress;
