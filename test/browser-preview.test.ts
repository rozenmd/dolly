import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import {
  capturePreview,
  elementExpression,
  PreviewCdp,
  type CdpParams,
  type CdpResult,
} from "../src/browser-preview";
import { resolveImages } from "../src/images";

class BrowserSocket extends EventTarget {
  commands: { id: number; method: string; params: CdpParams }[] = [];
  fail?: string;
  /** Runtime.evaluate results, in order; the last one repeats. */
  evaluations: CdpResult[] = [{ result: { value: { ready: true } } }];
  navigation: CdpResult = {};
  /** CDP command errors for Runtime.evaluate, used before evaluations. */
  evaluateErrors: string[] = [];
  /** Answers Runtime.evaluate by expression before evaluations, when it returns a result. */
  evaluate?: (expression: string) => CdpResult | undefined;
  accept = vi.fn();
  close = vi.fn();
  result(method: string, params: CdpParams) {
    if (method === "Page.captureScreenshot") return { data: btoa("png bytes") };

    if (method === "Page.navigate") return this.navigation;

    if (method !== "Runtime.evaluate") return {};
    const answer = this.evaluate?.(params.expression ?? "");

    if (answer) return answer;

    return this.evaluations.length > 1 ? this.evaluations.shift() : this.evaluations[0];
  }

  send(data: string) {
    const command = JSON.parse(data);
    this.commands.push(command);
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            id: command.id,
            ...(command.method === this.fail
              ? { error: { message: "deliberate failure" } }
              : command.method === "Runtime.evaluate" && this.evaluateErrors.length
                ? { error: { message: this.evaluateErrors.shift() } }
                : { result: this.result(command.method, command.params) }),
          }),
        }),
      );

      if (command.method === "Page.navigate")
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ method: "Page.loadEventFired" }),
          }),
        );
    });
  }
}

function browserBindingMock(value: Pick<BrowserRun, "acquire">) {
  // SAFETY: The fixture supplies every BrowserRun method exercised by capturePreview.
  return value as BrowserRun;
}

function fixture(fail?: string, configure: (socket: BrowserSocket) => void = () => {}) {
  const socket = new BrowserSocket();
  socket.fail = fail;
  configure(socket);

  const browser = {
    acquire: vi.fn(async () => ({ sessionId: "session" })),
    connectSession: vi.fn(async () => ({
      webSocket: { fetch: async () => ({ webSocket: socket }) },
    })),
    devtools: { newTarget: vi.fn(async () => ({ id: "page" })) },
    closeSession: vi.fn(async () => "closed"),
  };

  const bindings = { BROWSER: browserBindingMock(browser), SCREENSHOTS: env.SCREENSHOTS };

  return { socket, browser, bindings };
}

it("routes the browser privately, captures at the requested viewport, and persists only an R2 reference", async () => {
  const { browser, socket, bindings } = fixture();
  // SAFETY: Only identity is tested; the mocked BrowserRun never calls this Fetcher.
  const outbound = {} as Fetcher;

  const result = await capturePreview(bindings, outbound, "one.test", {
    action: "screenshot",
    path: "/hello",
    width: 800,
    height: 600,
    waitFor: "main",
  });

  expect(browser.acquire).toHaveBeenCalledWith({
    keepAlive: 60000,
    outboundByHost: { "one.test": outbound },
    guardrails: { allowedDomains: [] },
  });
  expect(socket.commands).toContainEqual(
    expect.objectContaining({
      method: "Page.navigate",
      params: { url: "http://one.test/hello" },
    }),
  );
  expect(socket.commands).toContainEqual(
    expect.objectContaining({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
    }),
  );
  const image = result.output.find((block) => block.type === "image");
  expect(image?.data).toMatch(/^r2:\/\/screenshots\/png\/[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain(btoa("png bytes"));

  const [message] = await resolveImages(bindings.SCREENSHOTS, [
    {
      role: "toolResult",
      toolCallId: "capture",
      toolName: "preview",
      content: result.output,
      isError: false,
      timestamp: 1,
    },
  ]);

  expect(message.content).toContainEqual({
    type: "image",
    mimeType: "image/png",
    data: btoa("png bytes"),
  });
  expect(socket.close).toHaveBeenCalledOnce();
  expect(browser.closeSession).toHaveBeenCalledWith("session");
});

it("closes the browser even when screenshot capture fails", async () => {
  const { browser, socket, bindings } = fixture("Page.captureScreenshot");
  // SAFETY: Only identity is tested; the mocked BrowserRun never calls this Fetcher.
  const outbound = {} as Fetcher;
  await expect(
    capturePreview(bindings, outbound, "one.test", { action: "screenshot" }),
  ).rejects.toThrow("deliberate failure");
  expect(socket.close).toHaveBeenCalledOnce();
  expect(browser.closeSession).toHaveBeenCalledWith("session");
});

it("closes acquired sessions when the CDP upgrade fails", async () => {
  const { browser, bindings } = fixture();
  browser.connectSession.mockRejectedValueOnce(new Error("upgrade failed"));
  // SAFETY: Only identity is tested; the mocked BrowserRun never calls this Fetcher.
  const outbound = {} as Fetcher;
  await expect(
    capturePreview(bindings, outbound, "one.test", { action: "screenshot" }),
  ).rejects.toThrow("upgrade failed");
  expect(browser.closeSession).toHaveBeenCalledWith("session");
});

it("rejects pending CDP commands when the connection closes", async () => {
  const socket = new BrowserSocket();
  socket.send = () => {};

  const pending = new PreviewCdp(socket).send("Page.enable");
  socket.dispatchEvent(new Event("close"));
  await expect(pending).rejects.toThrow("connection closed");
});

// SAFETY: Only identity is tested; the mocked BrowserRun never calls this Fetcher.
const unusedOutbound = {} as Fetcher;

it("says when the page loaded but the waitFor selector never appeared", async () => {
  const { socket, browser, bindings } = fixture(undefined, (socket) => {
    socket.evaluations = [
      {
        result: {
          value: {
            ready: false,
            selectorFound: false,
            readyState: "complete",
            url: "http://one.test/login?next=%2Fdashboard",
            title: "Sign in",
            text: "Sign in to continue",
          },
        },
      },
    ];
  });

  await expect(
    capturePreview(bindings, unusedOutbound, "one.test", {
      action: "screenshot",
      path: "/dashboard",
      waitFor: "#chart",
    }),
  ).rejects.toThrow(
    'The page at http://one.test/login?next=%2Fdashboard (requested http://one.test/dashboard) loaded, but waitFor selector "#chart" did not appear within 15 seconds; check the selector, or the path if the page redirected or shows an error. Title: "Sign in". Page text starts: "Sign in to continue".',
  );
  expect(socket.commands.map((command) => command.method)).not.toContain("Page.captureScreenshot");
  expect(browser.closeSession).toHaveBeenCalledWith("session");
});

it("says when the page never finished loading", async () => {
  const { bindings } = fixture(undefined, (socket) => {
    socket.evaluations = [
      { result: { value: { ready: false, readyState: "interactive", url: "http://one.test/" } } },
    ];
  });

  await expect(
    capturePreview(bindings, unusedOutbound, "one.test", { action: "screenshot" }),
  ).rejects.toThrow(
    'The page at http://one.test/ started loading but never finished (document.readyState is "interactive" after 15 seconds)',
  );
});

it("reports an invalid waitFor selector as such", async () => {
  const { bindings } = fixture(undefined, (socket) => {
    socket.evaluations = [
      {
        result: {
          value: {
            ready: false,
            invalidSelector: true,
            readyState: "complete",
            url: "http://one.test/",
          },
        },
      },
    ];
  });

  await expect(
    capturePreview(bindings, unusedOutbound, "one.test", { action: "screenshot", waitFor: "div[" }),
  ).rejects.toThrow(
    'waitFor "div[" is not a valid CSS selector; the page at http://one.test/ loaded.',
  );
});

it("checks the new document again after a client-side redirect destroys the old one", async () => {
  const { socket, bindings } = fixture(undefined, (socket) => {
    socket.evaluations = [
      {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "Execution context was destroyed." },
        },
      },
      { result: { value: { ready: true } } },
    ];
  });

  const result = await capturePreview(bindings, unusedOutbound, "one.test", {
    action: "screenshot",
  });

  expect(result.output.some((block) => block.type === "image")).toBe(true);
  expect(socket.commands.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(
    2,
  );
});

it("names a redirect loop after repeated destroyed contexts", async () => {
  const { bindings } = fixture(undefined, (socket) => {
    socket.evaluations = [
      {
        exceptionDetails: {
          exception: { description: "Execution context was destroyed.\n  at x" },
        },
      },
    ];
  });

  await expect(
    capturePreview(bindings, unusedOutbound, "one.test", { action: "screenshot" }),
  ).rejects.toThrow(
    "The page at http://one.test/ loaded but kept navigating during the readiness check (a client-side redirect or reload loop?): Execution context was destroyed.",
  );
});

it("says when navigation failed, so the page never loaded", async () => {
  const { bindings } = fixture(undefined, (socket) => {
    socket.navigation = { errorText: "net::ERR_CONNECTION_REFUSED" };
  });

  await expect(
    capturePreview(bindings, unusedOutbound, "one.test", { action: "screenshot", path: "/x" }),
  ).rejects.toThrow(
    "Preview navigation to http://one.test/x failed: net::ERR_CONNECTION_REFUSED; the page never loaded",
  );
});

it("retries when Chrome rejects the readiness check because the page navigated", async () => {
  const { socket, bindings } = fixture(undefined, (socket) => {
    socket.evaluateErrors = ["Inspected target navigated or closed"];
  });

  const result = await capturePreview(bindings, unusedOutbound, "one.test", {
    action: "screenshot",
  });

  expect(result.output.some((block) => block.type === "image")).toBe(true);
  expect(socket.commands.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(
    2,
  );
});

/** Element lookups answer with state(selector); readiness and settling answer ready. */
function elements(state: (selector: string, mode: string) => object) {
  return (expression: string) => {
    const lookup = /const selector = ("(?:[^"\\]|\\.)*");\s*const mode = "(\w+)"/.exec(expression);

    if (!lookup)
      return { result: { value: expression.includes("readyState") ? { ready: true } : true } };

    return { result: { value: state(JSON.parse(lookup[1]), lookup[2]) } };
  };
}

it("runs click, type, press, waitFor and wait actions through CDP before a retina capture", async () => {
  const { socket, bindings } = fixture(undefined, (socket) => {
    socket.evaluate = elements((selector) => ({
      ok: true,
      x: selector === "#menu" ? 40 : 10,
      y: 20,
    }));
  });

  const result = await capturePreview(bindings, unusedOutbound, "one.test", {
    action: "screenshot",
    width: 390,
    height: 844,
    scale: 2,
    actions: [
      { click: "#menu" },
      { waitFor: "[role=menu]" },
      { type: { selector: "input[name=q]", text: "hello" } },
      { press: "Enter" },
      { press: "a" },
      { wait: 50 },
    ],
  });

  expect(socket.commands).toContainEqual(
    expect.objectContaining({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: false },
    }),
  );

  const input = socket.commands
    .filter((command) => command.method.startsWith("Input."))
    .map((command) => [command.method, command.params]);

  expect(input).toEqual([
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 20 }],
    [
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 40, y: 20, button: "left", clickCount: 1 },
    ],
    [
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: 40, y: 20, button: "left", clickCount: 1 },
    ],
    ["Input.insertText", { text: "hello" }],
    [
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      },
    ],
    [
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    ],
    [
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        text: "a",
        unmodifiedText: "a",
      },
    ],
    [
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 },
    ],
  ]);
  // Every action precedes the capture.
  const methods = socket.commands.map((command) => command.method);
  expect(methods.lastIndexOf("Input.dispatchKeyEvent")).toBeLessThan(
    methods.indexOf("Page.captureScreenshot"),
  );
  const [text] = result.output;
  expect(text.type === "text" && JSON.parse(text.text)).toMatchObject({ scale: 2, actions: 6 });
});

it("names the failed action and why, and takes no screenshot", async () => {
  const { socket, browser, bindings } = fixture(undefined, (socket) => {
    socket.evaluate = elements((selector) =>
      selector === "#open"
        ? { ok: true, x: 1, y: 1 }
        : {
            ok: false,
            reason:
              "the matching element <button#save> is not clickable: <div#overlay> covers its centre",
          },
    );
  });

  await expect(
    capturePreview(bindings, unusedOutbound, "one.test", {
      action: "screenshot",
      actions: [{ click: "#open" }, { click: "#save" }, { press: "Escape" }],
    }),
  ).rejects.toThrow(
    'Screenshot action 2 of 3 (click "#save") failed: the matching element <button#save> is not clickable: <div#overlay> covers its centre (after waiting up to 5 seconds). No screenshot was taken; action 1 ran.',
  );
  const methods = socket.commands.map((command) => command.method);
  expect(methods).not.toContain("Page.captureScreenshot");
  expect(methods).not.toContain("Input.dispatchKeyEvent");
  expect(browser.closeSession).toHaveBeenCalledWith("session");
});

it("embeds action selectors in page scripts as data", () => {
  const expression = elementExpression('a"); alert(1); ("', "click", 5000);
  expect(expression).toContain(JSON.stringify('a"); alert(1); ("'));
});
