import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkspaceRequest } from "./workspace";
import { rpc } from "./operations";
import { githubRoutes, githubSetupRoutes } from "./github-routes";
import { authorizeAccess } from "./access";
import { AgentApi } from "./api";
import { ChildRequest, NewSession } from "./models";
import { OperationError } from "./operations";
import { exceptionDetails, redact } from "./diagnostics";
import type { Env } from "./env";

export { Agent } from "./agent";

export { Sandbox } from "./sandbox";

class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {}

const Message = Schema.Struct({
  content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  requestId: Schema.String.check(Schema.isUUID()),
});

/** Hono owns HTTP; Effect programs run once at the request boundary. */
function handle(
  c: Context<{ Bindings: Env }>,
  program: Effect.Effect<Response, OperationError | InvalidInput, AgentApi>,
) {
  const layer = AgentApi.layer(c.env);

  return Effect.runPromise(
    program.pipe(
      Effect.provide(layer),
      Effect.catchTag("InvalidInput", (error) =>
        Effect.succeed(c.json({ error: error.message }, 400)),
      ),
      Effect.catchTag("OperationError", (error) =>
        Effect.logError({
          event: "request_failed",
          path: c.req.routePath,
          operation: error.operation,
          error: exceptionDetails(error, [c.env.API_TOKEN]),
          details: redact(JSON.stringify(error.details), [c.env.API_TOKEN]),
        }).pipe(Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502))),
      ),
      Effect.catchCause((cause) =>
        Effect.logError({
          event: "request_defect",
          error: redact(Cause.pretty(cause), [c.env.API_TOKEN]),
        }).pipe(Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502))),
      ),
    ),
    { signal: c.req.raw.signal },
  );
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

// Browser redirects cannot supply a bearer token; these routes enforce Access themselves.
app.route("/", githubSetupRoutes);

app.use("/api/*", async (c, next) => {
  if (!c.env.API_TOKEN || c.env.API_TOKEN.length < 32)
    return c.json({ error: "Set API_TOKEN to at least 32 characters" }, 503);

  return bearerAuth<{ Bindings: Env }>({ token: c.env.API_TOKEN })(c, next);
});

app.use("/api/*", async (c, next) => {
  const access = await Effect.runPromise(authorizeAccess(c.req.raw, c.env), {
    signal: c.req.raw.signal,
  });

  if (access === "unconfigured")
    return c.json({ error: "Configure Cloudflare Access before using the API" }, 503);

  if (access === "denied")
    return c.json({ error: "Cloudflare Access authentication required" }, 401);
  await next();
});

app.use(
  "/api/*",
  bodyLimit({ maxSize: 65_536, onError: (c) => c.json({ error: "Body exceeds 64 KiB" }, 413) }),
);

app.post("/api/auth/codex", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;

      return c.json(yield* agent.startLogin);
    }),
  ),
);

app.get("/api/auth/codex", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;

      return c.json(yield* agent.pollLogin);
    }),
  ),
);

app.delete("/api/auth/codex", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;

      return c.json(yield* agent.logout);
    }),
  ),
);

app.post("/api/sessions", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.text()).pipe(
        Effect.flatMap((body) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(NewSession))(body || "{}"),
        ),
        Effect.mapError(
          () => new InvalidInput({ message: "Expected an optional model from the Codex catalog" }),
        ),
      );

      const agent = yield* AgentApi;
      const result = yield* agent.createSession(parsed.model, parsed.workspace);

      return c.json(result, "error" in result ? 409 : 201);
    }),
  ),
);

app.post("/api/sessions/:id/workspace", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WorkspaceRequest)),
        Effect.mapError(() => new InvalidInput({ message: "Expected a workspace action" })),
      );

      const result = yield* rpc("workspace.execute", async () =>
        c.env.AGENT.getByName("owner").workspace(c.req.param("id"), input),
      );

      return c.json(result, "error" in result ? 409 : 200);
    }),
  ),
);

app.get("/api/sessions/:id/children", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.children(c.req.param("id"));

      return result ? c.json(result) : c.json({ error: "Session not found" }, 404);
    }),
  ),
);

app.post("/api/sessions/:id/children", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ ...ChildRequest.fields, requestId: Message.fields.requestId }),
          ),
        ),
        Effect.mapError(
          () =>
            new InvalidInput({
              message: "Expected content, a UUID requestId and an optional Codex model",
            }),
        ),
      );

      const agent = yield* AgentApi;
      const result = yield* agent.spawnChild(c.req.param("id"), parsed);

      if (!result) return c.json({ error: "Session not found" }, 404);

      return c.json(result, "error" in result ? 409 : 202);
    }),
  ),
);

app.post("/api/sessions/:id/children/:childId/messages", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Message)),
        Effect.mapError(
          () => new InvalidInput({ message: "Expected content and a UUID requestId" }),
        ),
      );

      const agent = yield* AgentApi;
      const result = yield* agent.sendChild(c.req.param("id"), c.req.param("childId"), parsed);

      if (!result) return c.json({ error: "Session not found" }, 404);

      return c.json(result, "error" in result ? 409 : 202);
    }),
  ),
);

app.get("/api/sessions/:id/tasks/:taskId", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.childTask(c.req.param("id"), c.req.param("taskId"));

      return result && !("error" in result)
        ? c.json(result)
        : c.json({ error: "Task not found" }, 404);
    }),
  ),
);

app.get("/api/sessions/:id", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.transcript(c.req.param("id"));

      return result
        ? c.body(result, 200, { "Content-Type": "application/json" })
        : c.json({ error: "Session not found" }, 404);
    }),
  ),
);

app.post("/api/sessions/:id/messages", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const parsed = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Message)),
        Effect.mapError(
          () => new InvalidInput({ message: "Expected content and a UUID requestId" }),
        ),
      );

      const agent = yield* AgentApi;
      const result = yield* agent.prompt(c.req.param("id"), parsed.content, parsed.requestId);

      if (!result) return c.json({ error: "Session not found" }, 404);

      return c.json(result, "error" in result ? 409 : 202);
    }),
  ),
);

app.post("/api/sessions/:id/abort", (c) =>
  handle(
    c,
    Effect.gen(function* () {
      const agent = yield* AgentApi;
      const result = yield* agent.abort(c.req.param("id"));

      return result ? c.json(result) : c.json({ error: "Session not found" }, 404);
    }),
  ),
);

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();

  return Effect.runPromise(
    Effect.logError({
      event: "http_failure",
      error: exceptionDetails(error, [c.env.API_TOKEN]),
    }).pipe(Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502))),
  );
});

app.route("/", githubRoutes);

export default app;

export { GitHubIngress } from "./github-ingress";

export { WorkspaceOutbound } from "./git-transport";
