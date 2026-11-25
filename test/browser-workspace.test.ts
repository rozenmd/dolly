import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import { browserRoute, MAX_BROWSER_SESSIONS, type SandboxOutbound } from "../src/browser-workspace";
import type { WorkspaceOutbound } from "../src/git-transport";
import { workspaceConfig } from "../src/workspace";

function browserBindingMock(value: Pick<BrowserRun, "launch"> & Partial<BrowserRun>) {
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

  let launched = 0;

  const launch = vi.fn(async () => ({
    sessionId: `session-${++launched}`,
    webSocket: { fetch, connect },
  }));

  const closeSession = vi.fn(async (_sessionId: string) => ({ status: "closed" as const }));
  const open = new Set<string>();
  const pending: Promise<unknown>[] = [];

  // Like ctx.waitUntil, keep cleanup alive after the relay returns; tests await it explicitly.
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });

  const settled = () => Promise.all(pending);

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

  return {
    browser: browserBindingMock({ launch, closeSession }),
    launch,
    closeSession,
    fetch,
    browsers,
    leases,
    open,
    waitUntil,
    settled,
  };
}

const upgrade = (query = "") =>
  new Request(`http://browser.workspace/devtools/browser${query}`, {
    headers: { Upgrade: "websocket" },
  });

const noSandbox = () => undefined;

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

it("relays a fresh Browser Run session with clean upgrade headers and closes it on disconnect", async () => {
  const { browser, launch, closeSession, browsers, leases, open, waitUntil, settled } = fixture();

  const response = await browserRoute(
    upgrade(),
    browser,
    ["example.com"],
    leases,
    noSandbox,
    waitUntil,
  );

  expect(response.status).toBe(101);
  // A relayed pair carries no upstream headers, so strict clients see one Upgrade header.
  expect([...response.headers.keys()]).toEqual([]);
  expect(launch).toHaveBeenCalledWith({
    keepAlive: 60_000,
    guardrails: { allowedDomains: ["example.com"] },
    outboundByHost: {},
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
  expect(closeSession).not.toHaveBeenCalled();
  client.close(1000, "done");
  await closed;
  // Cleanup outlives the relay through waitUntil rather than a dropped fire-and-forget call.
  await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
  await settled();
  expect(open.size).toBe(0);
  expect(closeSession).toHaveBeenCalledExactlyOnceWith("session-1");
});

it("closes the session and frees the lease when Browser Run ends the connection", async () => {
  const { browser, closeSession, browsers, leases, open, waitUntil, settled } = fixture();
  const response = await browserRoute(upgrade(), browser, [], leases, noSandbox, waitUntil);
  const client = response.webSocket;

  if (!client) throw new Error("Expected a WebSocket");
  client.accept();
  const closed = new Promise((resolve) => client.addEventListener("close", resolve));
  browsers[0].close(1001, "Browser Run session ended");
  await closed;
  await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
  await settled();
  expect(open.size).toBe(0);
  expect(closeSession).toHaveBeenCalledExactlyOnceWith("session-1");
});

it("frees the lease even when closing the Browser Run session fails", async () => {
  const { browser, closeSession, leases, open, waitUntil, settled } = fixture();
  closeSession.mockRejectedValueOnce(new Error("Browser Run is unavailable"));
  const response = await browserRoute(upgrade(), browser, [], leases, noSandbox, waitUntil);
  const client = response.webSocket;

  if (!client) throw new Error("Expected a WebSocket");
  client.accept();
  client.close(1000, "done");
  await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
  await settled();
  expect(open.size).toBe(0);
  expect(closeSession).toHaveBeenCalledOnce();
});

it("closes a launched session that returns no WebSocket", async () => {
  const { closeSession, leases, open, waitUntil, settled } = fixture();

  const broken = browserBindingMock({
    launch: vi.fn(async () => ({
      sessionId: "no-socket",
      webSocket: {
        fetch: async () => new Response(null, { status: 500 }),
        connect: (): Socket => {
          throw new Error("unused");
        },
      },
    })),
    closeSession,
  });

  expect((await browserRoute(upgrade(), broken, [], leases, noSandbox, waitUntil)).status).toBe(
    502,
  );
  await settled();
  expect(open.size).toBe(0);
  expect(closeSession).toHaveBeenCalledExactlyOnceWith("no-socket");
});

it("caps concurrent sessions without launching more browsers", async () => {
  const { browser, launch, leases, waitUntil } = fixture();

  for (let index = 0; index < MAX_BROWSER_SESSIONS; index++)
    expect((await browserRoute(upgrade(), browser, [], leases, noSandbox, waitUntil)).status).toBe(
      101,
    );

  const refused = await browserRoute(upgrade(), browser, [], leases, noSandbox, waitUntil);

  expect(refused.status).toBe(429);
  expect(await refused.text()).toContain("close one and retry");
  expect(launch).toHaveBeenCalledTimes(MAX_BROWSER_SESSIONS);
});

it("releases the lease when Browser Run fails to launch", async () => {
  const { leases, open, waitUntil, settled } = fixture();

  const failing = browserBindingMock({
    launch: vi.fn(async () => {
      throw new Error("Browser Run is unavailable");
    }),
  });

  await expect(browserRoute(upgrade(), failing, [], leases, noSandbox, waitUntil)).rejects.toThrow(
    "unavailable",
  );
  await settled();
  expect(open.size).toBe(0);
});

it("launches nothing for requests that are not a browser WebSocket", async () => {
  const { browser, launch, leases, waitUntil } = fixture();

  for (const [url, init, status] of [
    ["http://browser.workspace/devtools/browser", {}, 426],
    ["http://browser.workspace/devtools/page/1", { headers: { Upgrade: "websocket" } }, 404],
    ["https://browser.workspace/devtools/browser", { headers: { Upgrade: "websocket" } }, 400],
    ["http://browser.workspace:9222/devtools/browser", { headers: { Upgrade: "websocket" } }, 400],
  ] as const)
    expect(
      (await browserRoute(new Request(url, init), browser, [], leases, noSandbox, waitUntil))
        .status,
    ).toBe(status);

  expect(launch).not.toHaveBeenCalled();
  expect(leases.acquireBrowser).not.toHaveBeenCalled();
});

it("holds the deployment-wide cap in the owner Agent", async () => {
  const agent = env.AGENT.getByName("owner");
  const leases = [];

  for (let index = 0; index < MAX_BROWSER_SESSIONS; index++)
    leases.push(await agent.acquireBrowser());

  expect(leases).toEqual(Array.from({ length: MAX_BROWSER_SESSIONS }, () => expect.any(String)));
  expect(await agent.acquireBrowser()).toBeNull();
  await agent.releaseBrowser(String(leases[0]));
  const again = await agent.acquireBrowser();
  expect(again).toEqual(expect.any(String));

  for (const lease of [...leases.slice(1), again]) await agent.releaseBrowser(String(lease));
});

it("routes http://sandbox.workspace to the requested container port", async () => {
  const { browser, launch, leases, waitUntil } = fixture();
  // SAFETY: Only identity is checked; Browser Run is mocked and never calls this Fetcher.
  const sandbox = {} as Fetcher;
  const ports: number[] = [];

  const response = await browserRoute(
    upgrade("?port=8787"),
    browser,
    [],
    leases,
    (port) => {
      ports.push(port);

      return sandbox;
    },
    waitUntil,
  );

  expect(response.status).toBe(101);
  expect(ports).toEqual([8787]);
  expect(launch).toHaveBeenCalledWith({
    keepAlive: 60_000,
    guardrails: { allowedDomains: [] },
    outboundByHost: { "sandbox.workspace": sandbox },
  });

  for (const [query, status] of [
    ["?port=80", 400],
    ["?port=70000", 400],
    ["?port=abc", 400],
  ] as const)
    expect(
      (await browserRoute(upgrade(query), browser, [], leases, noSandbox, waitUntil)).status,
    ).toBe(status);

  expect(
    (await browserRoute(upgrade("?port=3000"), browser, [], leases, noSandbox, waitUntil)).status,
  ).toBe(409);
  expect(launch).toHaveBeenCalledTimes(1);
});

it("serves sandbox.workspace only from a running container, without credentials or other hosts", async () => {
  const stub = env.SANDBOX.getByName(crypto.randomUUID());

  const result = await runInDurableObject(stub, async (_, state) => {
    // SAFETY: src/index.ts exports SandboxOutbound; mint its loopback in the owning DO.
    const loopback = entrypoints as Cloudflare.Exports & {
      SandboxOutbound: LoopbackForExport<typeof SandboxOutbound>;
    };

    const outbound = loopback.SandboxOutbound({ props: { sandbox: String(state.id), port: 8787 } });

    return {
      stopped: (await outbound.fetch("http://sandbox.workspace/")).status,
      elsewhere: (await outbound.fetch("http://example.com/")).status,
      port: (await outbound.fetch("http://sandbox.workspace:9000/")).status,
    };
  });

  expect(result).toEqual({ stopped: 503, elsewhere: 404, port: 404 });
});
