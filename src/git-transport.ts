import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import type { WorkspaceConfig } from "./workspace";

/** The first receive-pack command must update exactly the session branch, never delete it. */
export async function checkedPush(body: ReadableStream<Uint8Array> | null, branch: string) {
  if (!body) return null;
  const reader = body.getReader();
  let prefix = new Uint8Array(0);

  try {
    while (true) {
      if (prefix.length >= 4) {
        const header = new TextDecoder().decode(prefix.subarray(0, 4));

        if (!/^[0-9a-f]{4}$/.test(header)) break;
        const length = Number.parseInt(header, 16);

        if (length < 5) break;

        if (prefix.length >= length + 4) {
          const command = new TextDecoder()
            .decode(prefix.subarray(4, length))
            .split("\0")[0]
            .trimEnd();

          const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/heads\/[^\s]+)$/.exec(command);

          if (
            !match ||
            /^0+$/.test(match[2]) ||
            match[3] !== `refs/heads/${branch}` ||
            new TextDecoder().decode(prefix.subarray(length, length + 4)) !== "0000"
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
export class WorkspaceOutbound extends WorkerEntrypoint<Env, WorkspaceConfig> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === "github.workspace" && url.protocol === "http:")
      return this.env.AGENT.getByName("owner").gitTransport(request, this.ctx.props);

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
