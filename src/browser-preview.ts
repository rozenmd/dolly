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
      exceptionDetails: Schema.optional(
        Schema.Struct({
          text: Schema.optional(Schema.String),
          exception: Schema.optional(
            Schema.Struct({ description: Schema.optional(Schema.String) }),
          ),
        }),
      ),
      result: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
    }),
  ),
});

/** A CDP command result, as the preview client reads it. */
export type CdpResult = NonNullable<typeof CdpReply.Type.result>;

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

    const timer = setTimeout(
      () =>
        loaded.reject(
          new Error(
            `Preview page ${url} did not fire its load event within 20 seconds; the page never loaded (a dev server compiling this route on first request can take this long: retry, and check preview status logs)`,
          ),
        ),
      20_000,
    );

    // Navigation can fail before the load promise is awaited.
    void loaded.promise.catch(() => {});

    try {
      const result = await this.send("Page.navigate", { url });

      if (result.errorText)
        throw new Error(
          `Preview navigation to ${url} failed: ${result.errorText}; the page never loaded, so check preview status for the dev server's state and logs`,
        );
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

const PageReadiness = Schema.Struct({
  ready: Schema.Boolean,
  invalidSelector: Schema.optional(Schema.Boolean),
  selectorFound: Schema.optional(Schema.Boolean),
  readyState: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

/** Runs in the page: never throws, so a timeout reports what the page looked like. */
export function readinessExpression(selector: string, timeoutMs = 15_000) {
  return `(async () => {
    const deadline = Date.now() + ${timeoutMs};
    const selector = ${JSON.stringify(selector)};
    const found = () => {
      if (!selector) return true;
      try { return Boolean(document.querySelector(selector)); } catch { return undefined; }
    };
    const page = () => ({
      readyState: document.readyState,
      url: location.href,
      title: document.title,
      text: (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 300),
    });
    while (document.readyState !== "complete" || found() !== true) {
      if (found() === undefined) return { ready: false, invalidSelector: true, ...page() };
      if (Date.now() >= deadline) return { ready: false, selectorFound: found(), ...page() };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1000))]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { ready: true };
  })()`;
}

type ExceptionDetails = NonNullable<NonNullable<typeof CdpReply.Type.result>["exceptionDetails"]>;

function exceptionText(details: ExceptionDetails) {
  return details.exception?.description?.split("\n")[0] ?? details.text ?? "unknown error";
}

/** Explain a page that is not ready: never loaded, or loaded without the selector. */
export function readinessError(
  requested: string,
  selector: string | undefined,
  state: typeof PageReadiness.Type,
) {
  const where = `${state.url ?? requested}${state.url && state.url !== requested ? ` (requested ${requested})` : ""}`;
  const page = `${state.title ? ` Title: ${JSON.stringify(state.title)}.` : ""}${state.text ? ` Page text starts: ${JSON.stringify(state.text)}.` : ""}`;

  if (state.invalidSelector)
    return `waitFor ${JSON.stringify(selector)} is not a valid CSS selector; the page at ${where} loaded.`;

  if (state.readyState !== "complete")
    return `The page at ${where} started loading but never finished (document.readyState is ${JSON.stringify(state.readyState)} after 15 seconds); check preview status logs.${page}`;

  return `The page at ${where} loaded, but waitFor selector ${JSON.stringify(selector)} did not appear within 15 seconds; check the selector, or the path if the page redirected or shows an error.${page}`;
}

/** CDP command errors that mean a navigation replaced the evaluated document. */
const NAVIGATED =
  /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/;

/** Wait for document load and the optional selector, surviving client-side redirects. */
export async function waitForPage(cdp: PreviewCdp, url: string, selector?: string) {
  let failure = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    let reply: CdpResult;

    try {
      reply = await cdp.send("Runtime.evaluate", {
        expression: readinessExpression(selector ?? ""),
        awaitPromise: true,
        returnByValue: true,
      });
    } catch (error) {
      // Chrome can reject the command itself when navigation replaces the page.
      if (!(error instanceof Error) || !NAVIGATED.test(error.message)) throw error;
      failure = error.message;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (reply.exceptionDetails) {
      // A redirect or reload destroys the evaluation context; check the new document.
      failure = exceptionText(reply.exceptionDetails);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    const state = reply.result?.value;

    if (!Schema.is(PageReadiness)(state))
      throw new Error(`The page at ${url} loaded, but its readiness check returned no result`);

    if (state.ready) return;
    throw new Error(readinessError(url, selector, state));
  }

  throw new Error(
    `The page at ${url} loaded but kept navigating during the readiness check (a client-side redirect or reload loop?): ${failure}`,
  );
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

    await waitForPage(cdp, url, input.waitFor);

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
