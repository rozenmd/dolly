import { expect, test } from "./browser";

// Sessions have opensession's URLs: /workspace/<workspaceId>/session/<sessionId>, where the
// workspace is the root session a thread hangs off.
const now = Date.now();

const session = { model: "gpt-6-sol", repository: "octocat/project", archived: false };

const sessions = [
  { ...session, id: "root", title: "Coordinate the release", updatedAt: now },
  {
    ...session,
    id: "child",
    parentId: "root",
    title: "Investigate the flaky test",
    updatedAt: now - 1_000,
  },
  { ...session, id: "other", title: "Polish the settings page", updatedAt: now - 2_000 },
];

const transcript = (text: string) => ({
  entries: [
    {
      id: 1,
      kind: "pi.user",
      model: [{ role: "user", content: text, timestamp: now - 60_000 }],
    },
  ],
  docs: {},
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions") return route.fulfill({ json: sessions });

    if (path === "/api/auth")
      return route.fulfill({
        json: {
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
        },
      });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/*/events", (socket) => {
    const id = new URL(socket.url()).pathname.split("/").at(-2) ?? "";
    socket.send(JSON.stringify(transcript(`Prompt for ${id}`)));
  });
});

const path = (page: { evaluate: (fn: () => string) => Promise<string> }) =>
  page.evaluate(() => window.location.pathname);

const heading = (page: Parameters<Parameters<typeof test>[1]>[0]["page"], name: string) =>
  page.getByRole("heading", { name, exact: true });

test("puts the open session in the URL and follows history", async ({ page }) => {
  // The root opens the most recent session and rewrites the address to it.
  await page.goto("/");
  await expect(heading(page, "Coordinate the release")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/root/session/root");

  // Choosing another session pushes its URL.
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await workspaces
    .locator(".workspace-row")
    .filter({ hasText: "Polish the settings page" })
    .click();
  await expect(heading(page, "Polish the settings page")).toBeVisible();
  await expect(page.getByText("Prompt for other")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/other/session/other");

  // Back returns to the previous session.
  await page.evaluate(() => history.back());
  await expect(heading(page, "Coordinate the release")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/root/session/root");

  await page.evaluate(() => history.forward());
  await expect(heading(page, "Polish the settings page")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/other/session/other");
});

test("opens a spawned session from its URL, scoped to its root's workspace", async ({ page }) => {
  await page.goto("/workspace/root/session/child");
  await expect(heading(page, "Investigate the flaky test")).toBeVisible();
  await expect(page.getByText("Prompt for child")).toBeVisible();
  // Its root stays lit in the sidebar and the address stays put.
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(workspaces.locator(".workspace-row.active")).toHaveText(/Coordinate the release/);
  await expect.poll(() => path(page)).toBe("/workspace/root/session/child");

  // A reload reopens the same session.
  await page.reload();
  await expect(heading(page, "Investigate the flaky test")).toBeVisible();
});

test("rewrites a bare or mis-scoped session link to its workspace URL", async ({ page }) => {
  await page.goto("/session/child");
  await expect(heading(page, "Investigate the flaky test")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/root/session/child");

  await page.goto("/workspace/other/session/child");
  await expect(heading(page, "Investigate the flaky test")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/root/session/child");
});
