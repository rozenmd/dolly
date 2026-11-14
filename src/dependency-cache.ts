import * as Effect from "effect/Effect";
import type { WorkspaceConfig } from "./workspace";

const maxArchiveBytes = 512 * 1024 * 1024;

/** The outbound capability supplies the repository; the sandbox cannot choose another prefix. */
export async function dependencyCache(
  request: Request,
  bucket: R2Bucket,
  workspace: WorkspaceConfig,
  token?: string,
) {
  if (!token || request.headers.get("X-Dolly-Dependency-Cache") !== token)
    return new Response("Dependency cache is only available during setup", { status: 403 });

  const url = new URL(request.url);
  const match = /^\/v1\/([a-f0-9]{64})$/.exec(url.pathname);

  if (
    url.protocol !== "http:" ||
    url.hostname !== "dependencies.workspace" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    !match
  )
    return new Response("Invalid dependency cache route", { status: 400 });

  if (request.method !== "GET" && request.method !== "PUT")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, PUT" } });

  const scope = JSON.stringify({
    repository: workspace.repository.toLowerCase(),
    ref: workspace.ref ?? "HEAD",
    networkHosts: [...(workspace.networkHosts ?? [])].map((host) => host.toLowerCase()).sort(),
  });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));

  const prefix = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const key = `v1/${prefix}/${match[1]}.tar.zst`;
  const started = Date.now();

  try {
    if (request.method === "GET") {
      const object = await bucket.get(key);
      await Effect.runPromise(
        Effect.logInfo({
          event: object ? "dependency_cache_hit" : "dependency_cache_miss",
          key,
          elapsedMs: Date.now() - started,
        }),
      );

      return object
        ? new Response(object.body, {
            headers: {
              "Content-Type": "application/zstd",
              "Content-Length": String(object.size),
              "Cache-Control": "no-store",
            },
          })
        : new Response("Cache miss", { status: 404 });
    }

    const length = Number(request.headers.get("Content-Length"));

    if (!request.body || !Number.isSafeInteger(length) || length <= 0 || length > maxArchiveBytes)
      return new Response("Archive requires a bounded Content-Length", { status: 413 });

    const object = await bucket.put(key, request.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/zstd" },
    });

    await Effect.runPromise(
      Effect.logInfo({
        event: object ? "dependency_cache_stored" : "dependency_cache_already_exists",
        key,
        size: length,
        elapsedMs: Date.now() - started,
      }),
    );

    return new Response(null, { status: object ? 201 : 412 });
  } catch {
    await Effect.runPromise(
      Effect.logWarning({ event: "dependency_cache_unavailable", elapsedMs: Date.now() - started }),
    );

    return new Response("Dependency cache unavailable", { status: 503 });
  }
}
