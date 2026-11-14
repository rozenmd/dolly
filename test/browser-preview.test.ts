import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import { capturePreview, PreviewCdp, type CdpParams } from "../src/browser-preview";
import { resolveImages } from "../src/images";

class BrowserSocket extends EventTarget {
  commands: { id: number; method: string; params: CdpParams }[] = [];
  fail?: string;
  accept = vi.fn();
  close = vi.fn();
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
              : {
                  result:
                    command.method === "Page.captureScreenshot" ? { data: btoa("png bytes") } : {},
                }),
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

function fixture(fail?: string) {
  const socket = new BrowserSocket();
  socket.fail = fail;

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
