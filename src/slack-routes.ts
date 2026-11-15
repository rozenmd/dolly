import { Hono } from "hono";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { rpc } from "./operations";
import { SlackSetup } from "./slack";
import type { Env } from "./env";

export const slackRoutes = new Hono<{ Bindings: Env }>();

slackRoutes.get("/api/integrations/slack", async (c) => {
  const result = await Effect.runPromise(
    rpc(
      "slack.status",
      async () => await c.env.AGENT.getByName("owner").slackStatus(new URL(c.req.url).origin),
    ),
  );

  return c.json(result, "error" in result ? 500 : 200);
});

slackRoutes.put("/api/integrations/slack", async (c) => {
  const parsed = await Effect.runPromise(
    Effect.tryPromise(() => c.req.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SlackSetup)),
      Effect.option,
    ),
  );

  if (Option.isNone(parsed))
    return c.json(
      {
        error:
          "Expected a bot token (xoxb-…), a signing secret, an optional allowed Slack member ID and an optional default repository",
      },
      400,
    );

  const result = await Effect.runPromise(
    rpc(
      "slack.configure",
      async () => await c.env.AGENT.getByName("owner").slackConfigure(parsed.value),
    ),
  );

  return c.json(result, "error" in result ? 409 : 200);
});

slackRoutes.delete("/api/integrations/slack", async (c) =>
  c.json(
    await Effect.runPromise(
      rpc("slack.remove", async () => await c.env.AGENT.getByName("owner").slackRemove()),
    ),
  ),
);
