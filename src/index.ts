import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { exceptionDetails } from "./diagnostics";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Env } from "./env";
export { Agent } from "./agent";
export { Sandbox } from "./sandbox";

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
app.post("/api/auth/codex", async (c) => c.json(await c.env.AGENT.getByName("owner").startLogin()));
app.get("/api/auth/codex", async (c) => c.json(await c.env.AGENT.getByName("owner").pollLogin()));
app.delete("/api/auth/codex", async (c) => c.json(await c.env.AGENT.getByName("owner").logout()));
app.post("/api/sessions", async (c) => {
  const result = await c.env.AGENT.getByName("owner").createSession();
  return c.json(result, "error" in result ? 409 : 201);
});
app.get("/api/sessions/:id", async (c) => {
  const result = await c.env.AGENT.getByName("owner").transcript(c.req.param("id"));
  return result ? c.body(result, 200, { "Content-Type": "application/json" }) : c.json({ error: "Session not found" }, 404);
});
app.post("/api/sessions/:id/messages", async (c) => {
  const parsed = z.object({ content: z.string().trim().min(1).max(32_768), requestId: z.uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Expected content and a UUID requestId" }, 400);
  const result = await c.env.AGENT.getByName("owner").prompt(c.req.param("id"), parsed.data.content, parsed.data.requestId);
  if (!result) return c.json({ error: "Session not found" }, 404);
  return c.json(result, "error" in result ? 409 : 202);
});
app.post("/api/sessions/:id/abort", async (c) => {
  const result = await c.env.AGENT.getByName("owner").abort(c.req.param("id"));
  return result ? c.json(result) : c.json({ error: "Session not found" }, 404);
});
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(JSON.stringify({ event: "request_failed", path: c.req.routePath, error: exceptionDetails(error, [c.env.API_TOKEN]) }));
  return c.json({ error: "Request failed; check Worker logs" }, 502);
});
export default app;
