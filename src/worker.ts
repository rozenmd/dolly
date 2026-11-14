import * as Effect from "effect/Effect";
import api from "./index";
import { authorizeAccess } from "./access";
import start from "../web/server";
import type { Env } from "./env";

export { Agent, Sandbox, GitHubIngress, WorkspaceOutbound, PreviewOutbound } from "./index";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api" || pathname.startsWith("/api/")) return api.fetch(request, env, ctx);

    const access = await Effect.runPromise(authorizeAccess(request, env), {
      signal: request.signal,
    });

    if (access !== "allowed")
      return Response.json(
        {
          error:
            access === "unconfigured"
              ? "Configure Cloudflare Access before using the web app"
              : "Cloudflare Access authentication required",
        },
        { status: access === "unconfigured" ? 503 : 401, headers: { "Cache-Control": "no-store" } },
      );

    const asset = await env.ASSETS.fetch(request);

    if (asset.status !== 404) return asset;

    const response = await start.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");

    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
