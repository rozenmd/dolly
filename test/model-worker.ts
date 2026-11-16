import { DurableObject } from "cloudflare:workers";

export { default } from "../src/index";

export {
  Agent,
  Sandbox,
  Codex,
  GitHubIngress,
  SlackIngress,
  WorkspaceOutbound,
  PreviewOutbound,
  SandboxOutbound,
} from "../src/index";

// Existing workerd scenarios simulate provider HTTP, not container execution.
// Keep that simulation at the new transport boundary, never in production code.
export class FixtureCodex extends DurableObject {
  private readonly requests = new Map<string, AbortController>();

  cancel(id: string) {
    this.requests.get(id)?.abort();
  }

  async fetch(request: Request) {
    const id = request.headers.get("x-dolly-request-id") ?? crypto.randomUUID();
    const controller = new AbortController();

    this.requests.set(id, controller);

    return globalThis
      .fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.headers.get("content-encoding")
          ? await request.arrayBuffer()
          : await request.text(),
        signal: controller.signal,
      })
      .catch((error) => {
        if (controller.signal.aborted) return new Response(null, { status: 499 });

        throw error;
      })
      .finally(() => this.requests.delete(id));
  }
}
