import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import { browserRoute, MAX_BROWSER_SESSIONS } from "../src/browser-workspace";
import type { WorkspaceOutbound } from "../src/git-transport";
import { workspaceConfig } from "../src/workspace";

function browserBindingMock(value: Pick<BrowserRun, "launch">) {
  // SAFETY: The fixture supplies every BrowserRun method browserRoute calls.
  return value as BrowserRun;
}

/** A Browser Run stand-in whose browser end of each socket the test can drive. */
function fixture() {
  const browsers: WebSocket[] = [];

  const fetch = vi.fn(async () => {
    const pair = new WebSocketPair();
    pair[0].accept();
    browsers.push(pair[0]);

    return new Response(null, { status: 101, webSocket: pair[1] });
  });

  const connect = (): Socket => {
    throw new Error("The broker only upgrades over fetch");
  };

  const launch = vi.fn(async () => ({ sessionId: "session", webSocket: { fetch, connect } }));
  const open = new Set<string>();

  const leases = {
    acquireBrowser: vi.fn(async () => {
      if (open.size >= MAX_BROWSER_SESSIONS) return null;
      const lease = crypto.randomUUID();
      open.add(lease);

      return lease;
    }),
    releaseBrowser: vi.fn(async (lease: string) => {
      open.delete(lease);
    }),
  };

  return { browser: browserBindingMock({ launch }), launch, fetch, browsers, leases, open };
}

const upgrade = () =>
  new Request("http://browser.workspace/devtools/browser", { headers: { Upgrade: "websocket" } });

const next = (socket: WebSocket) =>
  new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
  );

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

it("relays a fresh Browser Run session with clean upgrade headers and releases it on close", async () => {
  const { browser, launch, browsers, leases, open } = fixture();
  const response = await browserRoute(upgrade(), browser, ["example.com"], leases);

  expect(response.status).toBe(101);
  // A relayed pair carries no upstream headers, so strict clients see one Upgrade header.
  expect([...response.headers.keys()]).toEqual([]);
  expect(launch).toHaveBeenCalledWith({
    keepAlive: 60_000,
    guardrails: { allowedDomains: ["example.com"] },
  });
  expect(open.size).toBe(1);

  const client = response.webSocket;

  if (!client) throw new Error("Expected a WebSocket");
  client.accept();
  const toBrowser = next(browsers[0]);
  client.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  expect(await toBrowser).toBe('{"id":1,"method":"Browser.getVersion"}');
  const toClient = next(client);
  browsers[0].send('{"id":1,"result":{}}');
  expect(await toClient).toBe('{"id":1,"result":{}}');

  const closed = new Promise((resolve) => browsers[0].addEventListener("close", resolve));
  client.close(1000, "done");
  await closed;
  await vi.waitFor(() => expect(open.size).toBe(0));
});

it("caps concurrent sessions without launching more browsers", async () => {
  const { browser, launch, leases } = fixture();

  for (let index = 0; index < MAX_BROWSER_SESSIONS; index++)
    expect((await browserRoute(upgrade(), browser, [], leases)).status).toBe(101);

  const refused = await browserRoute(upgrade(), browser, [], leases);

  expect(refused.status).toBe(429);
  expect(await refused.text()).toContain("close one and retry");
  expect(launch).toHaveBeenCalledTimes(MAX_BROWSER_SESSIONS);
});

it("releases the lease when Browser Run fails to launch", async () => {
  const { leases, open } = fixture();

  const failing = browserBindingMock({
    launch: vi.fn(async () => {
      throw new Error("Browser Run is unavailable");
    }),
  });

  await expect(browserRoute(upgrade(), failing, [], leases)).rejects.toThrow("unavailable");
  expect(open.size).toBe(0);
});

it("launches nothing for requests that are not a browser WebSocket", async () => {
  const { browser, launch, leases } = fixture();

  for (const [url, init, status] of [
    ["http://browser.workspace/devtools/browser", {}, 426],
    ["http://browser.workspace/devtools/page/1", { headers: { Upgrade: "websocket" } }, 404],
    ["https://browser.workspace/devtools/browser", { headers: { Upgrade: "websocket" } }, 400],
    ["http://browser.workspace:9222/devtools/browser", { headers: { Upgrade: "websocket" } }, 400],
  ] as const)
    expect((await browserRoute(new Request(url, init), browser, [], leases)).status).toBe(status);

  expect(launch).not.toHaveBeenCalled();
  expect(leases.acquireBrowser).not.toHaveBeenCalled();
});

it("holds the deployment-wide cap in the owner Agent", async () => {
  const agent = env.AGENT.getByName("owner");
  const leases = [];

  for (let index = 0; index < MAX_BROWSER_SESSIONS; index++)
    leases.push(await agent.acquireBrowser());

  expect(leases.every((lease) => typeof lease === "string")).toBe(true);
  expect(await agent.acquireBrowser()).toBeNull();
  await agent.releaseBrowser(String(leases[0]));
  const again = await agent.acquireBrowser();
  expect(again).toEqual(expect.any(String));

  for (const lease of [...leases.slice(1), again]) await agent.releaseBrowser(String(lease));
});
