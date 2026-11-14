import { Buffer } from "node:buffer";
import { MAX_IMAGE_BYTES, storeImages } from "./images";
import type { Env } from "./env";
import type { PreviewRequest } from "./preview";
import * as Schema from "effect/Schema";

const CdpReply = Schema.Struct({
  id: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  result: Schema.optional(
    Schema.Struct({
      errorText: Schema.optional(Schema.String),
      data: Schema.optional(Schema.String),
      exceptionDetails: Schema.optional(Schema.Unknown),
    }),
  ),
});

export type CdpParams = {
  url?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  expression?: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
  format?: string;
  captureBeyondViewport?: boolean;
};

type CdpSocket = EventTarget & { send(data: string): void };

function parseReply(event: Event) {
  if (!(event instanceof MessageEvent) || !Schema.is(Schema.String)(event.data)) return;

  try {
    return Schema.decodeUnknownSync(CdpReply)(JSON.parse(event.data));
  } catch {
    return;
  }
}

/** Small CDP client; no browser binary or automation runtime in the container. */
export class PreviewCdp {
  private nextId = 0;
  constructor(private readonly socket: CdpSocket) {}

  async navigate(url: string) {
    const loaded = Promise.withResolvers<void>();

    // Observe load before navigating, rather than racing the old about:blank document.
    const listener = (event: Event) => {
      if (parseReply(event)?.method === "Page.loadEventFired") loaded.resolve();
    };

    this.socket.addEventListener("message", listener);
    const timer = setTimeout(() => loaded.reject(new Error("Preview page load timed out")), 20_000);
    // Navigation can fail before the load promise is awaited.
    void loaded.promise.catch(() => {});

    try {
      const result = await this.send("Page.navigate", { url });

      if (result.errorText) throw new Error(`Preview navigation failed: ${result.errorText}`);
      await loaded.promise;
    } finally {
      clearTimeout(timer);
      this.socket.removeEventListener("message", listener);
    }
  }

  send(method: string, params: CdpParams = {}) {
    return new Promise<NonNullable<typeof CdpReply.Type.result>>((resolve, reject) => {
      const id = ++this.nextId;

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("message", message);
        this.socket.removeEventListener("close", closed);
        this.socket.removeEventListener("error", closed);
      };

      const closed = () => {
        cleanup();
        reject(new Error("Browser Run connection closed"));
      };

      const message = (event: Event) => {
        const reply = parseReply(event);

        if (reply?.id !== id) return;
        cleanup();

        if (reply.error) reject(new Error(`Browser Run ${method}: ${reply.error.message}`));
        else resolve(reply.result ?? {});
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Browser Run ${method} timed out`));
      }, 20_000);

      this.socket.addEventListener("message", message);
      this.socket.addEventListener("close", closed);
      this.socket.addEventListener("error", closed);

      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

type ScreenshotRequest = Extract<typeof PreviewRequest.Type, { action: "screenshot" }>;

export async function capturePreview(
  env: Pick<Env, "BROWSER" | "SCREENSHOTS">,
  outbound: Fetcher,
  hostname: string,
  input: ScreenshotRequest,
  networkHosts: string[] = [],
) {
  // Guardrails do not cover outboundByHost: PreviewOutbound separately pins its route.
  const session = await env.BROWSER.acquire({
    keepAlive: 60_000,
    outboundByHost: { [hostname]: outbound },
    guardrails: { allowedDomains: networkHosts },
  });

  let socket: WebSocket | undefined;

  try {
    const target = await env.BROWSER.devtools.newTarget(session.sessionId, "about:blank");
    const connection = await env.BROWSER.connectSession(session.sessionId, { targetId: target.id });

    const response = await connection.webSocket.fetch("https://browser-binding.invalid", {
      headers: { Upgrade: "websocket" },
    });

    if (!response.webSocket) throw new Error("Browser Run did not return a WebSocket");
    socket = response.webSocket;
    socket.accept();
    const cdp = new PreviewCdp(socket);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: input.width ?? 1280,
      height: input.height ?? 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const url = `http://${hostname}${input.path ?? "/"}`;
    await cdp.navigate(url);

    const ready = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const deadline = Date.now() + 15000;
        const selector = ${JSON.stringify(input.waitFor ?? "")};
        while (document.readyState !== "complete" || (selector && !document.querySelector(selector))) {
          if (Date.now() >= deadline) throw new Error("Preview readiness timed out");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1000))]);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });

    if (ready.exceptionDetails)
      throw new Error("Preview did not become ready; check path or waitFor selector");

    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });

    if (!screenshot.data) throw new Error("Browser Run returned an empty screenshot");
    const size = Buffer.byteLength(screenshot.data, "base64");

    if (!size || size > MAX_IMAGE_BYTES)
      throw new Error("Screenshot exceeds the 5 MiB image limit");

    const images = await storeImages(env.SCREENSHOTS, [
      { mimeType: "image/png", data: screenshot.data },
    ]);

    return {
      output: [
        {
          type: "text" as const,
          text: JSON.stringify({
            path: input.path ?? "/",
            width: input.width ?? 1280,
            height: input.height ?? 800,
            image: images[0].data,
          }),
        },
        ...images,
      ],
    };
  } finally {
    try {
      socket?.close();
    } finally {
      await env.BROWSER.closeSession(session.sessionId);
    }
  }
}
