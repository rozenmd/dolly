import { Buffer } from "node:buffer";
import { STATUS_CODES } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CdpConnection, Json } from "./cdp";
import { CdpSession } from "./cdp";
import { Locator, type RoleOptions, type TextMatch } from "./locator";

/** Page-side support: routed WebSockets and a no-op for transpiler helpers in serialized functions. */
const bootstrap = `(() => {
  if (window.__dolly) return;
  globalThis.__name ??= (value) => value;
  const sockets = new Map();
  let next = 0;
  const notify = (message) => window.__dollyWebSocket(JSON.stringify(message));
  class RoutedWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    binaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    readyState = 0;
    constructor(url) {
      super();
      this.url = new URL(url, location.href).href;
      this.id = ++next;
      sockets.set(this.id, this);
      notify({ type: "open", id: this.id, url: this.url });
    }
    send(data) {
      if (this.readyState !== 1) throw new DOMException("WebSocket is not open", "InvalidStateError");
      notify({ type: "message", id: this.id, data: String(data) });
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      notify({ type: "close", id: this.id, code, reason });
      this.closed(code, reason);
    }
    emit(event) {
      this.dispatchEvent(event);
      const handler = this["on" + event.type];
      if (typeof handler === "function") handler.call(this, event);
    }
    closed(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      sockets.delete(this.id);
      this.emit(new CloseEvent("close", { code, reason, wasClean: true }));
    }
  }
  window.WebSocket = RoutedWebSocket;
  window.__dolly = {
    open(id) {
      const socket = sockets.get(id);
      if (!socket || socket.readyState !== 0) return;
      socket.readyState = 1;
      socket.emit(new Event("open"));
    },
    message(id, data) {
      const socket = sockets.get(id);
      if (socket?.readyState === 1)
        socket.emit(new MessageEvent("message", { data, origin: new URL(socket.url).origin }));
    },
    close(id, code, reason) {
      sockets.get(id)?.closed(code, reason);
    },
  };
})();`;

type Glob = string | RegExp;

/** Playwright-style URL globs: ** spans slashes, * does not. */
export function globMatcher(pattern: Glob) {
  if (pattern instanceof RegExp) return (url: string) => pattern.test(url);
  let source = "";

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === "*" && pattern[index + 1] === "*") {
      index++;

      if (pattern[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  const regex = new RegExp(`^${source}$`);

  return (url: string) => regex.test(url);
}

type PausedRequest = {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    postDataEntries?: { bytes?: string }[];
  };
};

export class Request {
  constructor(
    private readonly data: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: Buffer;
    },
  ) {}

  url() {
    return this.data.url;
  }

  method() {
    return this.data.method;
  }

  headers() {
    return Object.fromEntries(
      Object.entries(this.data.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
  }

  postData() {
    return this.data.body ? this.data.body.toString("utf8") : null;
  }

  postDataJSON() {
    const text = this.postData();

    return text === null ? null : JSON.parse(text);
  }
}

type Fulfillment = {
  status?: number;
  json?: unknown;
  body?: string | Buffer;
  contentType?: string;
  headers?: Record<string, string>;
};

export class Route {
  handled = false;

  constructor(
    private readonly page: Page,
    private readonly paused: PausedRequest,
    private readonly data: Request,
  ) {}

  request() {
    return this.data;
  }

  async fulfill(options: Fulfillment = {}) {
    this.handled = true;

    const headers = new Map(
      Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );

    let body = options.body;

    if (options.json !== undefined) {
      body = JSON.stringify(options.json);

      if (!headers.has("content-type"))
        headers.set("content-type", options.contentType ?? "application/json");
    } else if (options.contentType) headers.set("content-type", options.contentType);

    await this.page.fulfill(this.paused.requestId, options.status ?? 200, headers, body);
  }

  async abort() {
    this.handled = true;
    await this.page.session.send("Fetch.failRequest", {
      requestId: this.paused.requestId,
      errorReason: "Failed",
    });
  }
}

export class WebSocketRoute {
  private readonly messageHandlers: ((message: string) => void)[] = [];
  private readonly closeHandlers: ((code?: number, reason?: string) => void)[] = [];
  closed = false;

  constructor(
    private readonly page: Page,
    private readonly id: number,
    private readonly address: string,
    private readonly contextId: number,
  ) {}

  url() {
    return this.address;
  }

  send(message: string) {
    if (this.closed) return;
    void this.page.callInContext(this.contextId, "message", [this.id, message]);
  }

  close(options: { code?: number; reason?: string } = {}) {
    if (this.closed) return;
    this.closed = true;
    void this.page.callInContext(this.contextId, "close", [
      this.id,
      options.code ?? 1000,
      options.reason ?? "",
    ]);
  }

  onMessage(handler: (message: string) => void) {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (code?: number, reason?: string) => void) {
    this.closeHandlers.push(handler);
  }

  /** @internal */
  received(message: string) {
    for (const handler of this.messageHandlers) handler(message);
  }

  /** @internal */
  ended(code?: number, reason?: string) {
    this.closed = true;

    for (const handler of this.closeHandlers.splice(0)) handler(code, reason);
  }
}

type KeyDefinition = { code: string; keyCode: number; text?: string };

const KEYS = new Map<string, KeyDefinition>([
  ["Enter", { code: "Enter", keyCode: 13, text: "\r" }],
  ["Tab", { code: "Tab", keyCode: 9 }],
  ["Escape", { code: "Escape", keyCode: 27 }],
  ["Backspace", { code: "Backspace", keyCode: 8 }],
  ["Delete", { code: "Delete", keyCode: 46 }],
  ["ArrowUp", { code: "ArrowUp", keyCode: 38 }],
  ["ArrowDown", { code: "ArrowDown", keyCode: 40 }],
  ["ArrowLeft", { code: "ArrowLeft", keyCode: 37 }],
  ["ArrowRight", { code: "ArrowRight", keyCode: 39 }],
  ["Space", { code: "Space", keyCode: 32, text: " " }],
]);

const MODIFIERS = new Map([
  ["Alt", 1],
  ["Control", 2],
  ["Meta", 4],
  ["Shift", 8],
]);

type PageListener =
  | [event: "requestfinished", listener: (request: Request) => void]
  | [event: "pageerror", listener: (error: Error) => void];

type RouteHandler = (route: Route) => void | Promise<void>;

type SocketHandler = (socket: WebSocketRoute) => void | Promise<void>;

type WaitUntil = { waitUntil?: "load" | "networkidle" };

export class Page {
  readonly session: CdpSession;
  private readonly routes: {
    match: (url: string) => boolean;
    handler: RouteHandler;
  }[] = [];
  private readonly socketRoutes: {
    match: (url: string) => boolean;
    handler: SocketHandler;
  }[] = [];
  private readonly sockets = new Map<number, WebSocketRoute>();
  private readonly inflight = new Map<string, { method: string; url: string }>();
  private lastNetworkActivity = Date.now();
  private address = "about:blank";
  private readonly finishedListeners: ((request: Request) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  /** Errors thrown by route handlers; they fail the test, as in Playwright. */
  readonly handlerErrors: unknown[] = [];
  readonly keyboard = {
    press: (key: string) => this.press(key),
  };
  readonly mouse = {
    move: (x: number, y: number) =>
      this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
  };

  private constructor(
    connection: CdpConnection,
    sessionId: string,
    private readonly browserContextId: string,
    readonly baseURL: string,
    private readonly origin: string,
  ) {
    this.session = new CdpSession(connection, sessionId);
  }

  /** Open a page in a fresh browser context, so storage never leaks between tests. */
  static async create(connection: CdpConnection, baseURL: string, origin: string) {
    const { browserContextId } = await connection.send("Target.createBrowserContext", {
      disposeOnDetach: true,
    });

    const { targetId } = await connection.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });

    const { sessionId } = await connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    const page = new Page(connection, sessionId, browserContextId, baseURL, origin);

    await page.initialize();

    return page;
  }

  private async initialize() {
    const session = this.session;

    session.on("Page.frameNavigated", ({ frame }) => {
      if (!frame.parentId) this.address = frame.url;
    });
    session.on("Page.navigatedWithinDocument", ({ url }) => {
      this.address = url;
    });
    session.on("Fetch.requestPaused", (params: PausedRequest) => void this.paused(params));
    session.on("Network.requestWillBeSent", (params) => {
      this.lastNetworkActivity = Date.now();
      this.inflight.set(params.requestId, {
        method: params.request.method,
        url: params.request.url,
      });
    });
    session.on("Network.loadingFinished", (params) => {
      this.lastNetworkActivity = Date.now();
      const request = this.inflight.get(params.requestId);
      this.inflight.delete(params.requestId);

      if (!request) return;

      for (const listener of this.finishedListeners)
        listener(new Request({ ...request, headers: {} }));
    });
    session.on("Network.loadingFailed", (params) => {
      this.lastNetworkActivity = Date.now();
      this.inflight.delete(params.requestId);
    });
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      const description: string =
        exceptionDetails.exception?.description ?? exceptionDetails.text ?? "Error";

      const error = new Error(description.split("\n")[0].replace(/^[A-Za-z]*Error: /, ""));

      for (const listener of this.errorListeners) listener(error);
    });
    session.on("Runtime.bindingCalled", (params) => {
      if (params.name === "__dollyWebSocket")
        void this.socketEvent(JSON.parse(params.payload), params.executionContextId);
    });

    await Promise.all([
      session.send("Page.enable"),
      session.send("Runtime.enable"),
      session.send("Network.enable"),
      session.send("DOM.enable"),
      session.send("Accessibility.enable"),
      session.send("Runtime.addBinding", { name: "__dollyWebSocket" }),
      session.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap }),
      session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }),
      this.setViewportSize({ width: 1280, height: 720 }),
    ]);
  }

  async close() {
    this.session.dispose();
    await this.session.connection
      .send("Target.disposeBrowserContext", { browserContextId: this.browserContextId })
      .catch(() => {});
  }

  on(event: "requestfinished", listener: (request: Request) => void): void;
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(...[event, listener]: PageListener) {
    if (event === "requestfinished") this.finishedListeners.push(listener);
    else this.errorListeners.push(listener);
  }

  /** Later routes take precedence, as in Playwright. */
  async route(pattern: Glob, handler: RouteHandler) {
    this.routes.push({ match: globMatcher(pattern), handler });
  }

  async routeWebSocket(pattern: Glob, handler: SocketHandler) {
    this.socketRoutes.push({ match: globMatcher(pattern), handler });
  }

  async addInitScript<A extends Json = null>(script: (arg: A) => void, arg?: A) {
    await this.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${script.toString()})(${JSON.stringify(arg ?? null)})`,
    });
  }

  async setViewportSize({ width, height }: { width: number; height: number }) {
    await this.session.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async goto(path: string, options: WaitUntil = {}) {
    await this.navigate(
      () => this.session.send("Page.navigate", { url: new URL(path, this.baseURL).toString() }),
      options,
    );
  }

  async reload(options: WaitUntil = {}) {
    await this.navigate(() => this.session.send("Page.reload"), options);
  }

  private async navigate(
    start: () => Promise<{ errorText?: string }>,
    { waitUntil = "load" }: WaitUntil,
  ) {
    let dispose = () => {};

    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Navigation timed out")), 30_000);

      dispose = this.session.on("Page.loadEventFired", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    try {
      const result = await start();

      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      await loaded;
    } finally {
      dispose();
    }

    if (waitUntil === "networkidle") {
      const deadline = Date.now() + 30_000;

      while (this.inflight.size || Date.now() - this.lastNetworkActivity < 500) {
        if (Date.now() > deadline) throw new Error("Network did not become idle");
        await sleep(50);
      }
    }
  }

  /** The main frame's URL, including same-document history changes. */
  url() {
    return this.address;
  }

  async evaluate<R, A extends Json = null>(fn: (arg: A) => R, arg?: A): Promise<Awaited<R>> {
    const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;

    const result = await this.session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });

    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );

    // returnByValue: the page function's JSON result, typed by its caller.
    const value: Awaited<R> = result.result.value;

    return value;
  }

  async screenshot({ path }: { path: string }) {
    const { data } = await this.session.send("Page.captureScreenshot", { format: "png" });

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(data, "base64"));
  }

  async waitForTimeout(ms: number) {
    await sleep(ms);
  }

  async press(key: string) {
    const parts = key.split("+");
    const name = parts.pop()!;
    const modifiers = parts.reduce((mask, part) => mask | (MODIFIERS.get(part) ?? 0), 0);
    const single = name.length === 1;

    const definition = KEYS.get(name) ?? {
      code: single ? `Key${name.toUpperCase()}` : name,
      keyCode: single ? name.toUpperCase().charCodeAt(0) : 0,
      text: single ? name : undefined,
    };

    const base = {
      key: name === "Space" ? " " : name,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers,
    };

    const typed = definition.text !== undefined && !modifiers;

    await this.session.send("Input.dispatchKeyEvent", {
      type: typed ? "keyDown" : "rawKeyDown",
      ...base,
      text: typed ? definition.text : undefined,
    });
    await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  getByRole(role: string, options: RoleOptions = {}) {
    return new Locator(this, [{ kind: "role", role, options }]);
  }

  getByLabel(text: TextMatch, options: { exact?: boolean } = {}) {
    return new Locator(this, [{ kind: "label", text, exact: options.exact }]);
  }

  getByText(text: TextMatch, options: { exact?: boolean } = {}) {
    return new Locator(this, [{ kind: "text", text, exact: options.exact }]);
  }

  locator(selector: string) {
    return new Locator(this, [{ kind: "css", selector }]);
  }

  /** @internal */
  async callInContext(contextId: number, method: string, args: unknown[]) {
    await this.session
      .send("Runtime.evaluate", {
        expression: `window.__dolly.${method}(...${JSON.stringify(args)})`,
        contextId,
      })
      .catch(() => {});
  }

  /** @internal */
  async fulfill(
    requestId: string,
    status: number,
    headers: Map<string, string>,
    body?: string | Buffer,
  ) {
    await this.session
      .send("Fetch.fulfillRequest", {
        requestId,
        responseCode: status,
        responsePhrase: STATUS_CODES[status] ?? "Unknown",
        responseHeaders: [...headers].map(([name, value]) => ({ name, value })),
        body: Buffer.from(body ?? "").toString("base64"),
      })
      .catch(() => {});
  }

  private async paused(params: PausedRequest) {
    const { request } = params;

    const body = request.postDataEntries
      ? Buffer.concat(
          request.postDataEntries.map((entry) => Buffer.from(entry.bytes ?? "", "base64")),
        )
      : request.postData === undefined
        ? undefined
        : Buffer.from(request.postData);

    const data = new Request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
    });

    for (const { match, handler } of [...this.routes].reverse()) {
      if (!match(request.url)) continue;
      const route = new Route(this, params, data);

      try {
        await handler(route);
      } catch (error) {
        this.handlerErrors.push(error);

        if (!route.handled) await route.abort().catch(() => {});

        return;
      }

      if (route.handled) return;
    }

    await this.proxy(params, body);
  }

  /** Serve unrouted requests from Node, so a remote browser (container or Browser Run) reaches the local app. */
  private async proxy(params: PausedRequest, body?: Buffer) {
    const target = new URL(params.request.url);

    if (target.origin === new URL(this.baseURL).origin) {
      const origin = new URL(this.origin);
      target.protocol = origin.protocol;
      target.host = origin.host;
    }

    try {
      const response = await fetch(target, {
        method: params.request.method,
        headers: new Headers(params.request.headers),
        body:
          body && !["GET", "HEAD"].includes(params.request.method)
            ? new Uint8Array(body)
            : undefined,
        redirect: "manual",
      });

      const headers: { name: string; value: string }[] = [];

      response.headers.forEach((value, name) => {
        // fetch() has already decoded the body; set-cookie is listed separately below.
        if (
          !["content-encoding", "content-length", "transfer-encoding", "set-cookie"].includes(name)
        )
          headers.push({ name, value });
      });

      for (const value of response.headers.getSetCookie())
        headers.push({ name: "set-cookie", value });
      const bytes = Buffer.from(await response.arrayBuffer());

      await this.session
        .send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: response.status,
          responsePhrase: STATUS_CODES[response.status] ?? "Unknown",
          responseHeaders: headers,
          body: bytes.toString("base64"),
        })
        .catch(() => {});
    } catch {
      await this.session
        .send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Failed" })
        .catch(() => {});
    }
  }

  private async socketEvent(
    event:
      | { type: "open"; id: number; url: string }
      | { type: "message"; id: number; data: string }
      | { type: "close"; id: number; code: number; reason: string },
    contextId: number,
  ) {
    if (event.type === "open") {
      const routed = [...this.socketRoutes].reverse().find(({ match }) => match(event.url));
      const socket = new WebSocketRoute(this, event.id, event.url, contextId);

      this.sockets.set(event.id, socket);
      await this.callInContext(contextId, "open", [event.id]);

      if (!routed) return this.bridge(socket);

      try {
        await routed.handler(socket);
      } catch (error) {
        this.handlerErrors.push(error);
      }

      return;
    }

    const socket = this.sockets.get(event.id);

    if (!socket) return;

    if (event.type === "message") socket.received(event.data);
    else {
      this.sockets.delete(event.id);
      socket.ended(event.code, event.reason);
    }
  }

  /** Connect an unrouted page socket to the real server through Node. */
  private bridge(socket: WebSocketRoute) {
    const target = new URL(socket.url());

    if (target.host === new URL(this.baseURL).host) target.host = new URL(this.origin).host;
    target.protocol = target.protocol === "https:" || target.protocol === "wss:" ? "wss:" : "ws:";
    const upstream = new WebSocket(target);

    upstream.addEventListener("message", (event) => socket.send(String(event.data)));
    upstream.addEventListener("close", () => socket.close());
    upstream.addEventListener("error", () => socket.close({ code: 1011 }));
    socket.onMessage((message) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
    });
    socket.onClose(() => upstream.close());
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
