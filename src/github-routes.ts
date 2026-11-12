import { Hono } from "hono";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { authorizeAccess } from "./access";
import { WebhookSetup } from "./github-webhook";
import { GitHubRequest, GitHubSetup } from "./github-contracts";
import { rpc } from "./operations";
import type { Env } from "./env";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const githubRoutes = new Hono<{ Bindings: Env }>();

githubRoutes.use("/setup/github/*", async (c, next) => {
  const access = await Effect.runPromise(authorizeAccess(c.req.raw, c.env), {
    signal: c.req.raw.signal,
  });

  if (access !== "allowed")
    return c.json(
      { error: "Cloudflare Access authentication required" },
      access === "unconfigured" ? 503 : 401,
    );
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
  );
  await next();
});

githubRoutes.get("/api/integrations/github", async (c) =>
  c.json(
    await Effect.runPromise(
      rpc("github.status", async () => await c.env.AGENT.getByName("owner").githubStatus()),
    ),
  ),
);

githubRoutes.post("/api/integrations/github/setup", async (c) => {
  const parsed = await Effect.runPromise(
    Effect.tryPromise(() => c.req.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GitHubSetup)),
      Effect.option,
    ),
  );

  if (Option.isNone(parsed))
    return c.json(
      { error: "Expected owner, ownerType and 1–16 repositories owned by that account" },
      400,
    );
  const origin = new URL(c.req.url).origin;

  if (!origin.startsWith("https://")) return c.json({ error: "GitHub setup requires HTTPS" }, 400);

  const result = await Effect.runPromise(
    rpc(
      "github.setup",
      async () => await c.env.AGENT.getByName("owner").githubStart(parsed.value, origin),
    ),
  );

  return c.json(result);
});

githubRoutes.post("/api/integrations/github/execute", async (c) => {
  const parsed = await Effect.runPromise(
    Effect.tryPromise(() => c.req.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GitHubRequest)),
      Effect.option,
    ),
  );

  if (Option.isNone(parsed)) return c.json({ error: "Invalid GitHub operation" }, 400);

  return c.json(
    await Effect.runPromise(
      rpc(
        "github.execute",
        async () => await c.env.AGENT.getByName("owner").githubExecute(parsed.value),
      ),
    ),
  );
});

githubRoutes.get("/api/integrations/github/threads", async (c) =>
  c.json(
    await Effect.runPromise(
      rpc("github.threads", async () => await c.env.AGENT.getByName("owner").githubThreads()),
    ),
  ),
);

githubRoutes.put("/api/integrations/github/webhook", async (c) => {
  const parsed = await Effect.runPromise(
    Effect.tryPromise(() => c.req.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(WebhookSetup)),
      Effect.option,
    ),
  );

  if (Option.isNone(parsed))
    return c.json(
      {
        error: "Expected allowed senders and an optional webhook secret of at least 32 characters",
      },
      400,
    );

  const result = await Effect.runPromise(
    rpc(
      "github.webhook.configure",
      async () => await c.env.AGENT.getByName("owner").githubConfigureWebhook(parsed.value),
    ),
  );

  return c.json(result, "error" in result ? 409 : 200);
});

githubRoutes.get("/setup/github/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");

  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 512)
    return c.json({ error: "Invalid GitHub callback" }, 400);

  return c.json(
    await Effect.runPromise(
      rpc(
        "github.callback",
        async () => await c.env.AGENT.getByName("owner").githubComplete(state, code),
      ),
    ),
  );
});

githubRoutes.get("/setup/github/:state", async (c) => {
  const state = c.req.param("state");

  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return c.json({ error: "Invalid setup link" }, 400);

  const result = await Effect.runPromise(
    rpc("github.manifest", async () => await c.env.AGENT.getByName("owner").githubManifest(state)),
  );

  if ("error" in result) return c.json(result, 400);

  return c.html(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect GitHub</title><main><h1>Connect GitHub</h1><p>Create a private GitHub App, then install it on the repositories you approved.</p><form action="${escapeHtml(result.action)}" method="post"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(result.manifest))}"><button type="submit">Create GitHub App</button></form></main></html>`,
  );
});
