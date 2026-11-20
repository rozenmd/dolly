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

test("retains legacy archive choices through a failed batch and stops importing after success", async ({
  page,
}) => {
  const legacy = [
    session("visible", "Visible task"),
    ...Array.from({ length: 49 }, (_, i) => session(`old-${i}`, `Old task ${i}`, true)),
    session("last", "Last archived task", true),
  ];

  let server = [legacy[0], { ...legacy[50], archived: false }];
  let failLastBatch = true;
  const imports: (typeof legacy)[] = [];

  await page.addInitScript((sessions) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "true");
    localStorage.setItem("dolly.sessions.v1", JSON.stringify(sessions));
  }, legacy);
  await page.route("**/api/sessions/import", (route) => {
    const { sessions } = route.request().postDataJSON();
    imports.push(sessions);

    if (sessions[0]?.id === "last" && failLastBatch)
      return route.fulfill({ status: 503, json: { error: "Try again" } });

    if (sessions[0]?.id === "last") server = [server[0], sessions[0]];

    return route.fulfill({ json: { imported: true } });
  });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: server }));

  const batches = [legacy.slice(0, 50), legacy.slice(50)];
  const warning = page.getByText("Could not import browser archive choices", { exact: false });
  const archived = page.getByRole("button", { name: "Archived workspaces (1)", exact: true });

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(warning).toBeVisible();
  await expect(page.getByRole("heading", { name: "Visible task", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("dolly.sessions.v1"))).toBe(
    JSON.stringify(legacy),
  );
  expect(imports).toEqual(batches);

  await page.reload({ waitUntil: "networkidle" });
  await expect(warning).toBeVisible();
  expect(imports).toEqual([...batches, ...batches]);

  failLastBatch = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(archived).toBeVisible();
  await expect(warning).toHaveCount(0);
  expect(imports.slice(4)).toEqual(batches);
  expect(await page.evaluate(() => localStorage.getItem("dolly.sessions.v1"))).toBeNull();

  await page.reload({ waitUntil: "networkidle" });
  await expect(archived).toBeVisible();
  expect(imports).toHaveLength(6);
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
