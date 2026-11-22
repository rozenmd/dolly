import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type { WorkspaceConfig } from "./workspace";
import { dependencyCache } from "./dependency-cache";
import { BROWSER_HOST, browserRoute, SandboxOutbound } from "./browser-workspace";

/**
 * Reachable from every sandbox. Besides package registries, raw.githubusercontent.com serves
 * pinned files from public GitHub repositories, such as OpenAPI schemas that code generators
 * download. Requests carry no credentials: the outbound strips auth headers.
 */
const defaultNetworkHosts = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "raw.githubusercontent.com",
]);

/**
 * Every receive-pack command must update a branch other than `defaultBranch` and never delete
 * one. Force pushes are allowed: to the server they are ordinary updates.
 */
export async function checkedPush(body: ReadableStream<Uint8Array> | null, defaultBranch: string) {
  if (!body) return null;
  const reader = body.getReader();
  let prefix = new Uint8Array(0);
  let offset = 0;
  let commands = 0;

  const forward = () =>
    new ReadableStream<Uint8Array>({
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

  try {
    read: while (true) {
      while (prefix.length >= offset + 4) {
        const header = new TextDecoder().decode(prefix.subarray(offset, offset + 4));

        if (!/^[0-9a-f]{4}$/.test(header)) break read;
        const length = Number.parseInt(header, 16);

        // A flush ends the command list, which must hold at least one update.
        if (length === 0) {
          if (commands === 0) break read;

          return forward();
        }

        if (length < 5) break read;

        if (prefix.length < offset + length) break;

        const packet = new TextDecoder()
          .decode(prefix.subarray(offset + 4, offset + length))
          .trimEnd();

        offset += length;

        if (offset > 65_536) break read;

        // Shallow clones announce their boundary commits before ref updates.
        if (/^shallow [0-9a-f]{40}$/.test(packet)) {
          if (commands > 0) break read;
          continue;
        }

        const command = packet.split("\0")[0];
        const match = /^[0-9a-f]{40} ([0-9a-f]{40}) refs\/heads\/(\S+)$/.exec(command);

        if (!match || /^0+$/.test(match[1]) || match[2] === defaultBranch) break read;
        commands++;
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

/** Only a Sandbox can mint this per-conversation capability through ctx.exports. */
export class WorkspaceOutbound extends WorkerEntrypoint<
  Env,
  WorkspaceConfig & { dependencyCacheToken?: string; sandbox?: string }
> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === "dependencies.workspace")
      return dependencyCache(
        request,
        this.env.DEPENDENCY_CACHE,
        this.ctx.props,
        this.ctx.props.dependencyCacheToken,
      );

    if (url.hostname === "github.workspace" && url.protocol === "http:")
      return this.env.AGENT.getByName("owner").gitTransport(request, this.ctx.props);

    if (url.hostname === BROWSER_HOST)
      return browserRoute(
        request,
        this.env.BROWSER,
        this.ctx.props.networkHosts ?? [],
        this.env.AGENT.getByName("owner"),
        (port) => {
          const sandbox = this.ctx.props.sandbox;

          if (!sandbox) return undefined;

          // SAFETY: src/index.ts exports SandboxOutbound alongside this entrypoint.
          const exports = this.ctx.exports as Cloudflare.Exports & {
            SandboxOutbound: LoopbackForExport<typeof SandboxOutbound>;
          };

          return exports.SandboxOutbound({ props: { sandbox, port } });
        },
      );

    if (
      url.protocol !== "https:" ||
      url.port ||
      (!defaultNetworkHosts.has(url.hostname) &&
        !this.ctx.props.networkHosts?.some(
          (host) => host.toLowerCase() === url.hostname.toLowerCase(),
        ))
    )
      return new Response("Network destination not enabled for this session", { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    headers.delete("Cookie");
    headers.delete("Proxy-Authorization");

    return fetch(new Request(request, { headers, redirect: "manual" }));
  }
}

export function gitRoute(request: Request, repository: string) {
  const url = new URL(request.url);

  if (
    url.hostname !== "github.workspace" ||
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
