import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Effect from "effect/Effect";
import { MAX_WEBHOOK_BYTES } from "./github-webhook";
import { rpc } from "./operations";
import type { Env } from "./env";

/** Only this named entrypoint is bound to the public webhook Worker. */
export class GitHubIngress extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname !== "/hooks/github" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const headers = new Headers(c.req.raw.headers);
      headers.delete("Content-Length");
      c.req.raw = new Request(c.req.raw, { headers });
      await next();
    });
    app.use("*", bodyLimit({ maxSize: MAX_WEBHOOK_BYTES }));
    app.post("/hooks/github", async (c) => {
      const signature = c.req.header("X-Hub-Signature-256") ?? "";
      const event = c.req.header("X-GitHub-Event") ?? "";
      const body = await c.req.arrayBuffer();

      const result = await Effect.runPromise(
        rpc(
          "github.webhook",
          async () => await this.env.AGENT.getByName("owner").githubWebhook(body, signature, event),
        ),
      );

      return new Response(null, { status: result.status });
    });

    return app.fetch(request);
  }
}
