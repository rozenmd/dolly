import { env, exports as entrypoints } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { WorkspaceOutbound } from "../src/git-transport";
import { workspaceConfig } from "../src/workspace";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Sends each request through the sandbox's real outbound capability and records what left. */
async function egress(urls: string[], networkHosts: string[] = [], init?: RequestInit) {
  const sent: { url: string; authorization: string | null; cookie: string | null }[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input instanceof Request ? input : new Request(String(input));
    sent.push({
      url: request.url,
      authorization: request.headers.get("Authorization"),
      cookie: request.headers.get("Cookie"),
    });

    return new Response("upstream");
  });

  const props = workspaceConfig({ repository: "octocat/project", networkHosts }, "outbound");

  const statuses = await runInDurableObject(
    env.SANDBOX.getByName(crypto.randomUUID()),
    async () => {
      // SAFETY: src/index.ts exports WorkspaceOutbound; mint its loopback in the owning DO.
      const loopback = entrypoints as Cloudflare.Exports & {
        WorkspaceOutbound: LoopbackForExport<typeof WorkspaceOutbound>;
      };

      const outbound = loopback.WorkspaceOutbound({ props });
      const results: number[] = [];

      for (const url of urls) results.push((await outbound.fetch(url, init)).status);

      return results;
    },
  );

  return { statuses, sent };
}

it("lets every sandbox fetch raw.githubusercontent.com without credentials", async () => {
  const schema =
    "https://raw.githubusercontent.com/OnlineOrNot/api-schemas/0a0a0ad28c651096f4c496d4cf1b41091e4a8ceb/openapi.json";

  const { statuses, sent } = await egress([schema], [], {
    headers: { Authorization: "Bearer secret", Cookie: "session=secret" },
  });

  expect(statuses).toEqual([200]);
  expect(sent).toEqual([{ url: schema, authorization: null, cookie: null }]);
});

it("still refuses other GitHub hosts and insecure raw.githubusercontent.com requests", async () => {
  const { statuses, sent } = await egress([
    "https://codeload.github.com/OnlineOrNot/api-schemas/tar.gz/main",
    "https://api.github.com/repos/OnlineOrNot/api-schemas",
    "http://raw.githubusercontent.com/OnlineOrNot/api-schemas/main/openapi.json",
    "https://raw.githubusercontent.com:8443/OnlineOrNot/api-schemas/main/openapi.json",
  ]);

  expect(statuses).toEqual([403, 403, 403, 403]);
  expect(sent).toEqual([]);
});

it("lets every sandbox download Playwright browsers from its CDN mirrors", async () => {
  const builds = [
    "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1200/chromium-linux.zip",
    "https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/chromium/1200/chromium-linux.zip",
    "https://cdn.playwright.dev/builds/chromium/1200/chromium-linux.zip",
  ];

  const { statuses, sent } = await egress(
    [...builds, "http://cdn.playwright.dev/builds/chromium/1200/chromium-linux.zip"],
    [],
    { headers: { Authorization: "Bearer secret" } },
  );

  expect(statuses).toEqual([200, 200, 200, 403]);
  expect(sent).toEqual(builds.map((url) => ({ url, authorization: null, cookie: null })));
});

it("keeps package registries and configured hosts reachable", async () => {
  const { statuses, sent } = await egress(
    ["https://registry.npmjs.org/zod", "https://pkg.pr.new/example", "https://example.com/"],
    ["pkg.pr.new"],
  );

  expect(statuses).toEqual([200, 200, 403]);
  expect(sent.map(({ url }) => url)).toEqual([
    "https://registry.npmjs.org/zod",
    "https://pkg.pr.new/example",
  ]);
});
