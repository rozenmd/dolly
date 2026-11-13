import * as Effect from "effect/Effect";
import { WorkerEntrypoint } from "cloudflare:workers";
import { OperationError } from "./operations";
import { exceptionDetails } from "./diagnostics";
import type { Env } from "./env";
import type { WorkspaceConfig } from "./workspace";

/** The first receive-pack command must update exactly the session branch, never delete it. */
export async function checkedPush(body: ReadableStream<Uint8Array> | null, branch: string) {
  if (!body) return null;
  const reader = body.getReader();
  let prefix = new Uint8Array(0);
  let offset = 0;

  try {
    while (true) {
      if (prefix.length >= offset + 4) {
        const header = new TextDecoder().decode(prefix.subarray(offset, offset + 4));

        if (!/^[0-9a-f]{4}$/.test(header)) break;
        const length = Number.parseInt(header, 16);

        if (length < 5) break;

        if (prefix.length >= offset + length) {
          const packet = new TextDecoder()
            .decode(prefix.subarray(offset + 4, offset + length))
            .trimEnd();

          // Shallow clones announce their boundary commits before ref updates.
          // These are not writes; still validate every subsequent update.
          if (/^shallow [0-9a-f]{40}$/.test(packet)) {
            offset += length;

            if (offset > 65_536) break;
            continue;
          }

          if (prefix.length >= offset + length + 4) {
            const command = packet.split("\0")[0];
            const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/heads\/[^\s]+)$/.exec(command);

            if (
              !match ||
              /^0+$/.test(match[2]) ||
              match[3] !== `refs/heads/${branch}` ||
              new TextDecoder().decode(prefix.subarray(offset + length, offset + length + 4)) !==
                "0000"
            )
              break;

            return new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(prefix);
              },
              async pull(controller) {
                try {
                  const value = await reader.read();

                  if (value.done) {
                    reader.releaseLock();
                    controller.close();
                  } else controller.enqueue(value.value);
                } catch (error) {
                  reader.releaseLock();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                try {
                  await reader.cancel(reason);
                } finally {
                  reader.releaseLock();
                }
              },
            });
          }
        }
      }

      const next = await reader.read();

      if (next.done) break;
      const joined = new Uint8Array(prefix.length + next.value.length);
      joined.set(prefix);
      joined.set(next.value, prefix.length);
      prefix = joined;
    }

    await reader.cancel();
    reader.releaseLock();

    return null;
  } catch (error) {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }

    throw error;
  }
}

export type WorkspaceOutboundProps = WorkspaceConfig & { artifactRepository?: string };

/** Only a Sandbox can mint this per-conversation capability through ctx.exports. */
export class WorkspaceOutbound extends WorkerEntrypoint<Env, WorkspaceOutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === "github.workspace" && url.protocol === "http:")
      return this.env.AGENT.getByName("owner").gitTransport(request, this.ctx.props);

    if (url.hostname === "artifacts.workspace")
      return this.ctx.props.artifactRepository
        ? artifactTransport(request, this.env, this.ctx.props.artifactRepository)
        : new Response("Legacy workspace transport is disabled", { status: 403 });

    if (
      url.protocol !== "https:" ||
      url.port ||
      !this.ctx.props.networkHosts?.some(
        (host) => host.toLowerCase() === url.hostname.toLowerCase(),
      )
    )
      return new Response("Network destination not enabled for this session", { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    headers.delete("Cookie");
    headers.delete("Proxy-Authorization");

    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}

export function gitRoute(request: Request, repository: string, hostname = "github.workspace") {
  const url = new URL(request.url);

  if (
    url.hostname !== hostname ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const root = `/${repository}.git`;

  if (
    request.method === "GET" &&
    url.pathname === `${root}/info/refs` &&
    [...url.searchParams.keys()].length === 1
  ) {
    const service = url.searchParams.get("service");

    if (service === "git-upload-pack" || service === "git-receive-pack")
      return { write: service === "git-receive-pack", path: url.pathname + url.search };
  }

  if (
    request.method === "POST" &&
    !url.search &&
    (url.pathname === `${root}/git-upload-pack` || url.pathname === `${root}/git-receive-pack`)
  )
    return { write: url.pathname.endsWith("git-receive-pack"), path: url.pathname };

  return null;
}

/** Credentials exist only for the upstream request, never in the sandbox's remote URL. */
export async function artifactTransport(request: Request, env: Env, repository: string) {
  const route = gitRoute(request, repository, "artifacts.workspace");

  if (!route || route.write)
    return new Response("Legacy Artifact read route denied", { status: 403 });

  if (!env.WORKSPACES)
    return new Response("Legacy workspace migration is not enabled", { status: 403 });
  using repo = await env.WORKSPACES.get(repository);
  const info = await repo.info();
  const credential = await repo.createToken("read", 300);
  const headers = new Headers();

  for (const name of ["Content-Type", "Accept", "Git-Protocol", "Content-Encoding"]) {
    const value = request.headers.get(name);

    if (value) headers.set(name, value);
  }

  headers.set("Authorization", `Bearer ${credential.plaintext}`);

  try {
    const remote = new URL(info.remote);

    // The binding supplies this address. Local Artifacts uses loopback HTTP in development.
    if (remote.username || remote.password || remote.search || remote.hash)
      throw new Error("Artifacts returned an invalid Git remote");

    const response = await fetch(remote.href + route.path.slice(`/${repository}.git`.length), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();

      return new Response("Artifact Git redirects are forbidden", { status: 502 });
    }

    return response;
  } catch (cause) {
    // Fetch errors can contain the supplied Authorization header.
    throw new OperationError({
      operation: "artifacts.transport",
      message: "Artifacts Git transport failed",
      details: exceptionDetails(cause, [credential.plaintext, headers.get("Authorization") ?? ""]),
    });
  } finally {
    try {
      await repo.revokeToken(credential.id);
    } catch (cause) {
      await Effect.runPromise(
        Effect.logWarning({
          event: "artifacts_token_cleanup_failed",
          error: exceptionDetails(cause, [credential.plaintext]),
        }),
      );
    }
  }
}
