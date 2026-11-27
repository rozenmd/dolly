import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type { WorkspaceConfig } from "./workspace";
import { dependencyCache } from "./dependency-cache";
import { BROWSER_HOST, browserRoute, SandboxOutbound } from "./browser-workspace";

/**
 * Reachable from every sandbox. Besides package registries, raw.githubusercontent.com serves
 * pinned files from public GitHub repositories, such as OpenAPI schemas that code generators
 * download, and Playwright's CDN mirrors serve the browsers `playwright install` downloads.
 * Requests carry no credentials: the outbound strips auth headers.
 */
const defaultNetworkHosts = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "raw.githubusercontent.com",
  "cdn.playwright.dev",
  "playwright.download.prss.microsoft.com",
]);

/** A checked receive-pack request: forward `body`, or refuse it with `pushRefusal`. */
export type CheckedPush =
  | { accepted: true; body: ReadableStream<Uint8Array> }
  | { accepted: false; sideband: boolean };

/** Capabilities that make git demultiplex the receive-pack response into sideband channels. */
const SIDEBAND = new Set(["side-band", "side-band-64k"]);

/**
 * Every receive-pack command must update a branch other than `defaultBranch` and never delete
 * one. Force pushes are allowed: to the server they are ordinary updates.
 *
 * A body that is exactly one flush packet is git's probe: before streaming a pack larger than
 * http.postBuffer (1 MiB by default) it posts `0000` to check that the endpoint answers. It
 * carries no commands, so it changes nothing, and refusing it fails the push with a bare
 * `RPC failed; HTTP 403`. Pushing a new branch from a shallow checkout hits this whenever the
 * default branch has moved on: without a shared commit git sends the whole tree.
 */
export async function checkedPush(
  body: ReadableStream<Uint8Array> | null,
  defaultBranch: string,
): Promise<CheckedPush> {
  if (!body) return { accepted: false, sideband: false };
  const reader = body.getReader();
  let prefix = new Uint8Array(0);
  let offset = 0;
  let commands = 0;
  let sideband = false;

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
          if (commands > 0) return { accepted: true, body: forward() };

          // Only a lone flush, with nothing before or after it, is the probe.
          if (offset !== 0 || prefix.length !== 4) break read;

          while (true) {
            const next = await reader.read();

            if (next.done) {
              reader.releaseLock();

              return { accepted: true, body: new Blob([prefix]).stream() };
            }

            if (next.value.length > 0) break read;
          }
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

        const [command, capabilities] = packet.split("\0");

        // The first command lists the capabilities, which say how the refusal can be shown.
        if (commands === 0 && capabilities !== undefined)
          sideband = capabilities.split(" ").some((capability) => SIDEBAND.has(capability));

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

    return { accepted: false, sideband };
  } catch (error) {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }

    throw error;
  }
}

/**
 * Refuse a receive-pack request so git shows why. Git prints no body for a failed RPC, only
 * `RPC failed; HTTP 403`, but it prints sideband channel 3 as `remote: <reason>` and then fails
 * the push, so a client that asked for a sideband gets the reason there.
 */
export function pushRefusal(reason: string, sideband: boolean) {
  if (!sideband) return new Response(reason, { status: 403 });
  const payload = new TextEncoder().encode(`\x03${reason}\n`);
  const packet = new Uint8Array(payload.length + 4);
  packet.set(new TextEncoder().encode((payload.length + 4).toString(16).padStart(4, "0")));
  packet.set(payload, 4);

  return new Response(packet, {
    status: 200,
    headers: {
      "Content-Type": "application/x-git-receive-pack-result",
      "Cache-Control": "no-cache",
    },
  });
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
        (promise) => this.ctx.waitUntil(promise),
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
