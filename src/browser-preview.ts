import { Buffer } from "node:buffer";
import { MAX_IMAGE_BYTES, storeImages } from "./images";
import type { Env } from "./env";
import { MAX_PREVIEW_WAIT_MS, type PreviewAction, type PreviewRequest } from "./preview";
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
  type?: string;
  x?: number;
  y?: number;
  button?: string;
  clickCount?: number;
  key?: string;
  code?: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
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

/** How long click and type wait for their element to be present, visible and uncovered. */
export const ACTION_ELEMENT_MS = 5_000;

/** How long a waitFor action waits for its selector. */
export const ACTION_WAIT_FOR_MS = 15_000;

const ElementState = Schema.Struct({
  ok: Schema.Boolean,
  final: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
});

/**
 * Runs in the page: find selector's element, waiting up to timeoutMs for it to be ready for
 * mode (present; visible and uncovered for a click; focusable text for type). Never throws.
 */
export function elementExpression(
  selector: string,
  mode: "present" | "click" | "type",
  timeoutMs: number,
) {
  return `(async () => {
    const selector = ${JSON.stringify(selector)};
    const mode = ${JSON.stringify(mode)};
    const deadline = Date.now() + ${timeoutMs};
    const describe = (node) => {
      if (!(node instanceof Element)) return "nothing";
      const id = node.id ? "#" + node.id : "";
      const classes = typeof node.className === "string" && node.className.trim()
        ? "." + node.className.trim().split(/\\s+/).slice(0, 3).join(".") : "";
      return "<" + node.tagName.toLowerCase() + id + classes + ">";
    };
    const check = () => {
      let element;
      try { element = document.querySelector(selector); }
      catch { return { ok: false, final: true, reason: "it is not a valid CSS selector" }; }
      if (!element) return { ok: false, reason: "no element matches the selector" };
      if (mode === "present") return { ok: true };
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none")
        return { ok: false, reason: "the matching element " + describe(element) + " is not visible (it has no size or is hidden)" };
      if (element.disabled) return { ok: false, reason: "the matching element " + describe(element) + " is disabled" };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (mode === "type") {
        const editable = element.isContentEditable ||
          (element instanceof HTMLTextAreaElement) ||
          (element instanceof HTMLInputElement && !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(element.type));
        if (!editable) return { ok: false, final: true, reason: "the matching element " + describe(element) + " is not a text input, textarea or contenteditable element" };
        if (element.readOnly) return { ok: false, reason: "the matching element " + describe(element) + " is read-only" };
        element.focus();
        if (document.activeElement !== element) return { ok: false, reason: "the matching element " + describe(element) + " could not be focused" };
        if (typeof element.setSelectionRange === "function") {
          try { element.setSelectionRange(element.value.length, element.value.length); } catch {}
        }
        return { ok: true, x, y };
      }
      const top = document.elementFromPoint(x, y);
      if (!top || (top !== element && !element.contains(top)))
        return { ok: false, reason: "the matching element " + describe(element) + " is not clickable: " + describe(top) + " covers its centre" };
      return { ok: true, x, y };
    };
    for (;;) {
      const state = check();
      if (state.ok || state.final || Date.now() >= deadline) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })()`;
}

/** Wait for two frames so the page has painted what an action changed. */
const SETTLE = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`;

/** Evaluate in the page, retrying when an action's navigation replaced the document. */
async function evaluate(cdp: PreviewCdp, expression: string) {
  let failure = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    let reply: CdpResult;

    try {
      reply = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
    } catch (error) {
      if (!(error instanceof Error) || !NAVIGATED.test(error.message)) throw error;
      failure = error.message;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (!reply.exceptionDetails) return reply.result?.value;
    failure = exceptionText(reply.exceptionDetails);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`the page kept navigating (${failure})`);
}

async function findElement(
  cdp: PreviewCdp,
  selector: string,
  mode: "present" | "click" | "type",
  timeoutMs: number,
) {
  const state = await evaluate(cdp, elementExpression(selector, mode, timeoutMs));

  if (!Schema.is(ElementState)(state)) throw new Error("the page returned no element state");

  if (!state.ok) {
    const reason = state.reason ?? "the element was not ready";

    throw new Error(
      state.final ? reason : `${reason} (after waiting up to ${timeoutMs / 1000} seconds)`,
    );
  }

  return state;
}

/** CDP key definitions for press: named keys, or one printable character. */
export function keyDefinition(key: string) {
  const named = new Map<string, readonly [code: string, keyCode: number, text?: string]>([
    ["Enter", ["Enter", 13, "\r"]],
    ["Escape", ["Escape", 27]],
    ["Tab", ["Tab", 9]],
    ["Backspace", ["Backspace", 8]],
    ["Delete", ["Delete", 46]],
    ["Space", ["Space", 32, " "]],
    ["ArrowUp", ["ArrowUp", 38]],
    ["ArrowDown", ["ArrowDown", 40]],
    ["ArrowLeft", ["ArrowLeft", 37]],
    ["ArrowRight", ["ArrowRight", 39]],
    ["Home", ["Home", 36]],
    ["End", ["End", 35]],
    ["PageUp", ["PageUp", 33]],
    ["PageDown", ["PageDown", 34]],
  ]);

  const definition = named.get(key);

  if (definition) {
    const [code, keyCode, text] = definition;

    return { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode: keyCode, text };
  }

  const upper = key.toUpperCase();
  const letter = /^[A-Z]$/.test(upper);
  const digit = /^\d$/.test(key);

  return {
    key,
    code: letter ? `Key${upper}` : digit ? `Digit${key}` : "",
    windowsVirtualKeyCode: letter || digit ? upper.charCodeAt(0) : 0,
    text: key,
  };
}

/** A short label for an action in errors, such as `click "button.menu"`. */
export function describeAction(action: PreviewAction) {
  if ("click" in action) return `click ${JSON.stringify(action.click)}`;

  if ("type" in action) return `type into ${JSON.stringify(action.type.selector)}`;

  if ("press" in action) return `press ${action.press}`;

  if ("waitFor" in action) return `waitFor ${JSON.stringify(action.waitFor)}`;

  return `wait ${action.wait}ms`;
}

async function runAction(cdp: PreviewCdp, action: PreviewAction) {
  if ("click" in action) {
    const { x = 0, y = 0 } = await findElement(cdp, action.click, "click", ACTION_ELEMENT_MS);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

    for (const type of ["mousePressed", "mouseReleased"])
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  } else if ("type" in action) {
    await findElement(cdp, action.type.selector, "type", ACTION_ELEMENT_MS);
    await cdp.send("Input.insertText", { text: action.type.text });
  } else if ("press" in action) {
    const { text, ...key } = keyDefinition(action.press);
    const down: CdpParams = { type: "rawKeyDown", ...key };

    // A key with text also types it, as a keypress would.
    if (text) Object.assign(down, { type: "keyDown", text, unmodifiedText: text });
    await cdp.send("Input.dispatchKeyEvent", down);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  } else if ("waitFor" in action) {
    await findElement(cdp, action.waitFor, "present", ACTION_WAIT_FOR_MS);
  } else {
    await new Promise((resolve) => setTimeout(resolve, Math.min(action.wait, MAX_PREVIEW_WAIT_MS)));
  }

  await evaluate(cdp, SETTLE);
}

/** Run screenshot actions in order; an error names the failed action and why. */
export async function runActions(cdp: PreviewCdp, actions: readonly PreviewAction[]) {
  for (const [index, action] of actions.entries()) {
    try {
      await runAction(cdp, action);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Screenshot action ${index + 1} of ${actions.length} (${describeAction(action)}) failed: ${reason}. No screenshot was taken${index === 1 ? "; action 1 ran" : index ? `; actions 1–${index} ran` : ""}.`,
      );
    }
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
      deviceScaleFactor: input.scale ?? 1,
      mobile: false,
    });
    const url = `http://${hostname}${input.path ?? "/"}`;
    await cdp.navigate(url);

    await waitForPage(cdp, url, input.waitFor);

    if (input.actions?.length) {
      await runActions(cdp, input.actions);
      // An action may have navigated: capture a loaded, painted document.
      await waitForPage(cdp, url);
    }

    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });

    if (!screenshot.data) throw new Error("Browser Run returned an empty screenshot");
    const size = Buffer.byteLength(screenshot.data, "base64");

    if (!size || size > MAX_IMAGE_BYTES)
      throw new Error(
        "Screenshot exceeds the 5 MiB image limit; lower scale, width or height and retry",
      );

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
            scale: input.scale ?? 1,
            actions: input.actions?.length ?? 0,
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
