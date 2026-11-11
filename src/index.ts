import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AgentApi } from "./api";
import { OperationError } from "./operations";
import { exceptionDetails, redact } from "./diagnostics";
import type { Env } from "./env";
export { Agent } from "./agent";
export { Sandbox } from "./sandbox";

class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", { message: Schema.String }) {}
const Message = Schema.Struct({
  content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  requestId: Schema.String.check(Schema.isUUID()),
});

/** Hono owns HTTP; Effect programs run once at the request boundary. */
function handle(c: Context<{ Bindings: Env }>, program: Effect.Effect<Response, OperationError | InvalidInput, AgentApi>) {
  const layer = AgentApi.layer(c.env);
  return Effect.runPromise(program.pipe(
    Effect.provide(layer),
    Effect.catchTag("InvalidInput", (error) => Effect.succeed(c.json({ error: error.message }, 400))),
    Effect.catchTag("OperationError", (error) => Effect.logError({
      event: "request_failed", path: c.req.routePath, operation: error.operation,
      error: exceptionDetails(error, [c.env.API_TOKEN]),
      details: redact(JSON.stringify(error.details), [c.env.API_TOKEN]),
    }).pipe(Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502)))),
    Effect.catchCause((cause) => Effect.logError({ event: "request_defect", error: redact(Cause.pretty(cause), [c.env.API_TOKEN]) }).pipe(
      Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502)),
    )),
  ), { signal: c.req.raw.signal });
}

const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/health", (c) => c.json({ ok: true }));
app.use("/api/*", async (c, next) => {
  if (!c.env.API_TOKEN || c.env.API_TOKEN.length < 32) return c.json({ error: "Set API_TOKEN to at least 32 characters" }, 503);
  return bearerAuth<{ Bindings: Env }>({ token: c.env.API_TOKEN })(c, next);
});
app.use("/api/*", bodyLimit({ maxSize: 65_536, onError: (c) => c.json({ error: "Body exceeds 64 KiB" }, 413) }));
app.post("/api/auth/codex", (c) => handle(c, Effect.gen(function*() {
  const agent = yield* AgentApi;
  return c.json(yield* agent.startLogin);
})));
app.get("/api/auth/codex", (c) => handle(c, Effect.gen(function*() {
  const agent = yield* AgentApi;
  return c.json(yield* agent.pollLogin);
})));
app.delete("/api/auth/codex", (c) => handle(c, Effect.gen(function*() {
  const agent = yield* AgentApi;
  return c.json(yield* agent.logout);
})));
app.post("/api/sessions", (c) => handle(c, Effect.gen(function*() {
  const agent = yield* AgentApi;
  const result = yield* agent.createSession;
  return c.json(result, "error" in result ? 409 : 201);
})));
app.get("/api/sessions/:id", (c) => handle(c, Effect.gen(function*() {
  const agent = yield* AgentApi;
  const result = yield* agent.transcript(c.req.param("id"));
  return result ? c.body(result, 200, { "Content-Type": "application/json" }) : c.json({ error: "Session not found" }, 404);
})));
app.post("/api/sessions/:id/messages", (c) => handle(c, Effect.gen(function*() {
  const parsed = yield* Effect.tryPromise(() => c.req.json<unknown>()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Message)),
    Effect.mapError(() => new InvalidInput({ message: "Expected content and a UUID requestId" })),
  );
  const agent = yield* AgentApi;
  const result = yield* agent.prompt(c.req.param("id"), parsed.content, parsed.requestId);
  if (!result) return c.json({ error: "Session not found" }, 404);
  return c.json(result, "error" in result ? 409 : 202);
})));
app.post("/api/sessions/:id/abort", (c) => handle(c, Effect.gen(function*() {
  const agent = yield* AgentApi;
  const result = yield* agent.abort(c.req.param("id"));
  return result ? c.json(result) : c.json({ error: "Session not found" }, 404);
})));
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  return Effect.runPromise(Effect.logError({ event: "http_failure", error: exceptionDetails(error, [c.env.API_TOKEN]) }).pipe(
    Effect.as(c.json({ error: "Request failed; check Worker logs" }, 502)),
  ));
});
export default app;
