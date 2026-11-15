import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import { browserRoute } from "../src/browser-workspace";
import type { WorkspaceOutbound } from "../src/git-transport";
import { workspaceConfig } from "../src/workspace";

function browserBindingMock(value: Pick<BrowserRun, "launch">) {
  // SAFETY: The fixture supplies every BrowserRun method browserRoute calls.
  return value as BrowserRun;
}

function fixture() {
  const pair = new WebSocketPair();
  const fetch = vi.fn(async () => new Response(null, { status: 101, webSocket: pair[1] }));

  const connect = (): Socket => {
    throw new Error("The broker only upgrades over fetch");
  };

  const launch = vi.fn(async () => ({ sessionId: "session", webSocket: { fetch, connect } }));

  return { browser: browserBindingMock({ launch }), launch, fetch, pair };
}

it("serves a DevTools version document naming the brokered browser WebSocket", async () => {
  const props = workspaceConfig({ repository: "octocat/project" }, "browser");

  const result = await runInDurableObject(env.SANDBOX.getByName(crypto.randomUUID()), async () => {
    // SAFETY: src/index.ts exports WorkspaceOutbound; mint its loopback in the owning DO.
    const loopback = entrypoints as Cloudflare.Exports & {
      WorkspaceOutbound: LoopbackForExport<typeof WorkspaceOutbound>;
    };

    const outbound = loopback.WorkspaceOutbound({ props });
    const version = await outbound.fetch("http://browser.workspace/json/version");

    return {
      status: version.status,
      body: await version.json(),
      missing: (await outbound.fetch("http://browser.workspace/elsewhere")).status,
    };
  });

  expect(result).toMatchObject({
    status: 200,
    body: { webSocketDebuggerUrl: "ws://browser.workspace/devtools/browser" },
    missing: 404,
  });
});

it("launches a Browser Run session per connection with the workspace's network guardrails", async () => {
  const { browser, launch, fetch, pair } = fixture();

  const response = await browserRoute(
    new Request("http://browser.workspace/devtools/browser", { headers: { Upgrade: "websocket" } }),
    browser,
    ["example.com"],
  );

  expect(response.status).toBe(101);
  expect(response.webSocket).toBe(pair[1]);
  expect(launch).toHaveBeenCalledWith({
    keepAlive: 60_000,
    guardrails: { allowedDomains: ["example.com"] },
  });
  expect(fetch).toHaveBeenCalledWith("https://browser-binding.invalid", {
    headers: { Upgrade: "websocket" },
  });
});

it("launches nothing for requests that are not a browser WebSocket", async () => {
  const { browser, launch } = fixture();

  for (const [url, init, status] of [
    ["http://browser.workspace/devtools/browser", {}, 426],
    ["http://browser.workspace/devtools/page/1", { headers: { Upgrade: "websocket" } }, 404],
    ["https://browser.workspace/devtools/browser", { headers: { Upgrade: "websocket" } }, 400],
    ["http://browser.workspace:9222/devtools/browser", { headers: { Upgrade: "websocket" } }, 400],
  ] as const)
    expect((await browserRoute(new Request(url, init), browser, [])).status).toBe(status);

  expect(launch).not.toHaveBeenCalled();
});
