import { expect, test } from "./browser";

const auth = {
  github: {
    connected: true,
    owner: "octocat",
    appSlug: "dolly-test",
    installUrl: "https://github.com/apps/dolly-test/installations/new",
    settingsUrl: "https://github.com/settings/apps/dolly-test",
    ingress: null,
    senders: ["octocat"],
    reviews: false,
  },
  ownerClaimed: true,
  user: { login: "octocat" },
};

function session(id: string, title: string, archived = false) {
  return { id, title, archived, model: "gpt-6-sol", repository: "", updatedAt: 1 };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/*/events", (socket) =>
    socket.send(JSON.stringify({ entries: [], docs: {} })),
  );
});

test("ignores retired browser archive data and uses the server list", async ({ page }) => {
  const legacy = [session("task", "Old browser title", true)];
  let imports = 0;

  await page.addInitScript((sessions) => {
    const key = "dolly.sessions.v1";
    localStorage.setItem(key, JSON.stringify(sessions));
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) document.documentElement.dataset.legacySessionRead = "true";

      return getItem.call(this, name);
    };
  }, legacy);
  await page.route("**/api/sessions/import", (route) => {
    imports++;

    return route.fulfill({ status: 404 });
  });
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ json: [session("task", "Server task")] }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Server task", exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.dataset.legacySessionRead),
  ).toBeUndefined();
  expect(imports).toBe(0);
});

test("loads server sessions while provider discovery waits and coalesces focus refreshes", async ({
  page,
}) => {
  const startup = Promise.withResolvers<void>();
  const polling = Promise.withResolvers<void>();
  const provider = Promise.withResolvers<void>();
  let lists = 0;
  await page.addInitScript(() => {
    // Count at fetch dispatch, before a request reaches the fixture.
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (input === "/api/sessions") {
        const root = document.documentElement;
        root.dataset.sessionFetches = String(Number(root.dataset.sessionFetches ?? 0) + 1);
      }

      return original(input, init);
    };
  });
  await page.route("**/api/auth/chatgpt", async (route) => {
    await provider.promise;

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.route("**/api/sessions", async (route) => {
    const call = ++lists;

    if (call === 1) await startup.promise;

    if (call === 2) await polling.promise;

    return route.fulfill({ json: [session("task", `Server task ${call}`)] });
  });

  const focus = () =>
    page.evaluate(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();

      return Number(document.documentElement.dataset.sessionFetches);
    });

  try {
    await page.goto("/");
    await expect.poll(() => lists).toBe(1);
    expect(await focus()).toBe(1);
    startup.resolve();
    await expect(page.getByRole("heading", { name: "Server task 1", exact: true })).toBeVisible();

    expect(await focus()).toBe(2);
    await expect.poll(() => lists).toBe(2);
    expect(await focus()).toBe(2);
    polling.resolve();
    await expect(page.getByRole("heading", { name: "Server task 2", exact: true })).toBeVisible();

    expect(await focus()).toBe(3);
    await expect(page.getByRole("heading", { name: "Server task 3", exact: true })).toBeVisible();
  } finally {
    startup.resolve();
    polling.resolve();
    provider.resolve();
  }
});
