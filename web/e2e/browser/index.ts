/**
 * Browser tests over the Chrome DevTools Protocol, without Playwright. The browser can be a
 * container, Cloudflare Browser Run or a local Chrome; see setup.ts. The API mirrors the
 * subset of @playwright/test these suites use.
 */
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect as vitestExpect,
  test as vitestTest,
} from "vite-plus/test";
import { CdpConnection } from "./cdp";
import { Page } from "./page";

export { expect } from "./expect";
export type { Page } from "./page";
export type { Locator } from "./locator";

type Fixtures = { page: Page };

let connection: CdpConnection | undefined;
let current: Page | undefined;

const outputRoot = join(import.meta.dirname, "../../test-results");

const slug = (name: string) =>
  name
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);

const outputPath = (name: string) =>
  join(outputRoot, slug(vitestExpect.getState().currentTestName ?? "test"), name);

// Registered on import, so the page exists before any test.beforeEach in a spec runs.
beforeEach(async () => {
  const endpoint = process.env.BROWSER_WS_ENDPOINT;
  const baseURL = process.env.E2E_BASE_URL;

  if (!endpoint || !baseURL) throw new Error("Run browser tests through vitest.e2e.config.ts");

  if (!connection || connection.closed)
    connection = await CdpConnection.connect(endpoint, process.env.BROWSER_CDP_TOKEN);
  current = await Page.create(connection, baseURL, process.env.E2E_SERVER_URL ?? baseURL);
});

afterEach(async (context) => {
  const page = current;
  current = undefined;

  if (!page) return;

  try {
    if (context.task.result?.state === "fail")
      await page.screenshot({ path: outputPath("failure.png") }).catch(() => {});

    if (page.handlerErrors.length) throw page.handlerErrors[0];
  } finally {
    await page.close();
  }
});

afterAll(() => {
  connection?.close();
  connection = undefined;
});

const fixtures = (): Fixtures => {
  if (!current) throw new Error("The browser page is not ready");

  return { page: current };
};

export const test = Object.assign(
  (name: string, body: (fixtures: Fixtures) => Promise<void>) =>
    vitestTest(name, () => body(fixtures())),
  {
    beforeEach: (body: (fixtures: Fixtures) => Promise<void>) => beforeEach(() => body(fixtures())),
    describe,
    info: () => ({ outputPath }),
  },
);
