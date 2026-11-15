import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Effect from "effect/Effect";
import { rpc } from "./operations";
import { MAX_SLACK_BYTES } from "./slack-events";
import type { Env } from "./env";

/** Only this named entrypoint is bound to the public ingress Worker for Slack. */
export class SlackIngress extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      const headers = new Headers(c.req.raw.headers);
      headers.delete("Content-Length");
      c.req.raw = new Request(c.req.raw, { headers });
      await next();
    });
    app.use("*", bodyLimit({ maxSize: MAX_SLACK_BYTES }));

    for (const route of ["events", "actions"] as const)
      app.post(`/slack/${route}`, async (c) => {
        const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
        const signature = c.req.header("X-Slack-Signature") ?? "";
        const body = await c.req.arrayBuffer();
        const agent = this.env.AGENT.getByName("owner");

        const result = await Effect.runPromise(
          rpc(`slack.${route}`, async () =>
            route === "events"
              ? await agent.slackEvents(body, timestamp, signature)
              : await agent.slackActions(body, timestamp, signature),
          ),
        );

        if ("challenge" in result) return c.json({ challenge: result.challenge });

        return new Response(null, { status: result.status });
      });

    app.notFound(() => new Response("Not found", { status: 404 }));

    return app.fetch(request);
  }
}
