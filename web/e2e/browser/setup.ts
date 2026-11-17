/**
 * Global setup for browser tests: start the built test Worker and find a browser.
 *
 * Browsers, in order of preference:
 * - BROWSER_CDP_URL=http://browser.workspace inside a Dolly sandbox: Cloudflare Browser Run,
 *   brokered by Dolly's Worker with no credentials in the sandbox.
 * - BROWSER_CDP_URL: a DevTools endpoint. Either http://host:port of a browser container
 *   (for example chromedp/headless-shell, started with HOVER_FLAG) or a ws(s):// URL such as
 *   Cloudflare Browser Run's, with BROWSER_CDP_TOKEN sent as a bearer token.
 * - BROWSER_EXECUTABLE: a local Chrome or Chromium binary, launched headless.
 *
 * Every request the page makes is served from Node, so a remote browser needs no route
 * to the local Worker. Set E2E_BASE_URL to reuse an already running server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserWebSocket } from "./cdp";
import { sleep } from "./page";

/** Report a fine pointer that can hover, as on a desktop; headless Chrome otherwise matches (hover: none). */
export const HOVER_FLAG =
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";

/** Dolly's sandbox host brokering Cloudflare Browser Run (src/browser-workspace.ts). */
const BROKER = "browser.workspace";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function waitFor(url: string, server: ChildProcess) {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited with ${server.exitCode}`);

    try {
      await fetch(url);

      return;
    } catch {
      await sleep(250);
    }
  }

  throw new Error(`Test server did not start at ${url}`);
}

async function launch(executable: string) {
  const profile = await mkdtemp(join(tmpdir(), "dolly-browser-"));

  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      HOVER_FLAG,
      ...(process.env.BROWSER_ARGS?.split(" ").filter(Boolean) ?? []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Browser did not start:\n${output}`)), 30_000);

    browser.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);

      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    browser.on("exit", (code) => reject(new Error(`Browser exited with ${code}:\n${output}`)));
  });

  return {
    endpoint,
    stop: async () => {
      browser.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export default async function setup() {
  const stops: (() => Promise<void> | void)[] = [];

  if (!process.env.E2E_BASE_URL) {
    const url = "http://127.0.0.1:8787";

    // The test Worker built by `pnpm test:integration:worker`.
    const server = spawn(
      "pnpm",
      [
        "exec",
        "vp",
        "-C",
        ".",
        "preview",
        "--config",
        "test/worker/vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        "8787",
        "--strictPort",
      ],
      { cwd: root, stdio: "inherit", detached: true },
    );

    stops.push(() => {
      if (server.pid) process.kill(-server.pid);
    });
    await waitFor(url, server);
    process.env.E2E_BASE_URL = url;
  }

  if (process.env.BROWSER_CDP_URL && new URL(process.env.BROWSER_CDP_URL).hostname === BROKER) {
    // Dolly's Browser Run broker: Browser Run blocks navigation to local addresses, so pages
    // load from http://sandbox.workspace, routed to the test server's port in this sandbox.
    // The harness still serves every request itself.
    const server = new URL(process.env.E2E_BASE_URL);
    process.env.BROWSER_WS_ENDPOINT = `ws://${BROKER}/devtools/browser?port=${server.port || 80}`;
    process.env.E2E_PAGE_URL = "http://sandbox.workspace";
  } else if (process.env.BROWSER_CDP_URL)
    process.env.BROWSER_WS_ENDPOINT = await browserWebSocket(process.env.BROWSER_CDP_URL);
  else if (process.env.BROWSER_EXECUTABLE) {
    const browser = await launch(process.env.BROWSER_EXECUTABLE);
    stops.push(browser.stop);
    process.env.BROWSER_WS_ENDPOINT = browser.endpoint;
  } else
    throw new Error(
      "Set BROWSER_CDP_URL to a browser container or Cloudflare Browser Run endpoint, or BROWSER_EXECUTABLE to a local Chrome",
    );

  return async () => {
    for (const stop of stops.reverse()) await stop();
  };
}
