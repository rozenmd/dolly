import { Hono, type Context } from "hono";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { rpc } from "./operations";
import { AutomationPatch, NewAutomation } from "./automations";
import type { Env } from "./env";

/** Settings > Automations: stored prompts that start sessions on a trigger (automations.ts). */
export const automationRoutes = new Hono<{ Bindings: Env }>();

const owner = (c: Context<{ Bindings: Env }>) => c.env.AGENT.getByName("owner");

const RunRequest = Schema.Struct({ requestId: Schema.String.check(Schema.isUUID()) });

async function body<A, I>(c: Context<{ Bindings: Env }>, schema: Schema.Codec<A, I>) {
  return Effect.runPromise(
    Effect.tryPromise(() => c.req.json<unknown>()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.option,
    ),
  );
}

const call = <A>(operation: string, run: () => Promise<A>) =>
  Effect.runPromise(rpc(operation, run));

const FIELDS =
  "name, prompt, and optionally schedule (five-field cron), timeZone, runAt (ISO 8601 with an offset), event (pull_request), enabled, readOnly, workspace ({ repository, ref?, networkHosts? }), model, thinkingLevel and mcpServers";

automationRoutes.get("/api/automations", async (c) =>
  c.json({
    automations: await call("automations.list", async () => await owner(c).automationsList()),
  }),
);

automationRoutes.post("/api/automations", async (c) => {
  const parsed = await body(c, NewAutomation);

  if (Option.isNone(parsed)) return c.json({ error: `Expected ${FIELDS}` }, 400);

  const result = await call(
    "automations.create",
    async () => await owner(c).automationCreate(parsed.value),
  );

  return c.json(result, "error" in result ? 400 : 201);
});

automationRoutes.get("/api/automations/:id", async (c) => {
  const result = await call(
    "automations.read",
    async () => await owner(c).automationRead(c.req.param("id")),
  );

  return result ? c.json(result) : c.json({ error: "Automation not found" }, 404);
});

automationRoutes.put("/api/automations/:id", async (c) => {
  const parsed = await body(c, AutomationPatch);

  if (Option.isNone(parsed))
    return c.json({ error: `Expected at least one of ${FIELDS}; null clears a field` }, 400);

  const result = await call(
    "automations.update",
    async () => await owner(c).automationUpdate(c.req.param("id"), parsed.value),
  );

  if (!result) return c.json({ error: "Automation not found" }, 404);

  return c.json(result, "error" in result ? 400 : 200);
});

automationRoutes.delete("/api/automations/:id", async (c) => {
  const result = await call(
    "automations.delete",
    async () => await owner(c).automationDelete(c.req.param("id")),
  );

  return result ? c.json(result) : c.json({ error: "Automation not found" }, 404);
});

automationRoutes.post("/api/automations/:id/run", async (c) => {
  const parsed = await body(c, RunRequest);

  if (Option.isNone(parsed)) return c.json({ error: "Expected a UUID requestId" }, 400);

  const result = await call(
    "automations.run",
    async () => await owner(c).automationRun(c.req.param("id"), parsed.value.requestId),
  );

  if (!result) return c.json({ error: "Automation not found" }, 404);

  return c.json(result, "error" in result ? 409 : 202);
});
