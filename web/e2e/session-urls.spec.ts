import { expect, test, type Page } from "./browser";

// Workspaces group sessions: one sidebar row each, their sessions as tabs, and session URLs
// of the form /workspace/<workspaceId>/session/<sessionId>.
const now = Date.now();

const base = { model: "gpt-6-sol", repository: "octocat/project", archived: false };

const fixture = [
  {
    ...base,
    id: "root",
    workspaceId: "w1",
    createdAt: now - 60_000,
    title: "Coordinate the release",
    updatedAt: now,
  },
  {
    ...base,
    id: "sibling",
    workspaceId: "w1",
    createdAt: now - 30_000,
    title: "Write the migration",
    updatedAt: now - 500,
  },
  {
    ...base,
    id: "child",
    parentId: "root",
    title: "Investigate the flaky test",
    updatedAt: now - 1_000,
  },
  {
    ...base,
    id: "other",
    workspaceId: "w2",
    createdAt: now - 90_000,
    title: "Polish the settings page",
    updatedAt: now - 2_000,
  },
];

let sessions: typeof fixture = [];
let created: { workspaceId?: string }[] = [];
let updates: unknown[] = [];

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
  sessions = structuredClone(fixture);
  created = [];
  updates = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/sessions" && method === "POST") {
      created.push(route.request().postDataJSON());

      return route.fulfill({ json: { id: "new", workspaceId: "w1", model: "gpt-6-sol" } });
    }

    if (path === "/api/sessions") return route.fulfill({ json: sessions });

    if (path.startsWith("/api/sessions/") && method === "PUT") {
      const id = path.split("/").at(-1);
      const body = route.request().postDataJSON();
      updates.push({ id, ...body });
      sessions = sessions.map((session) => (session.id === id ? { ...session, ...body } : session));

      return route.fulfill({ json: body });
    }

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
            reviews: false,
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

const path = (page: Page) => page.evaluate(() => window.location.pathname);

const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Workspaces", exact: true });

const tabs = (page: Page) =>
  page
    .getByRole("navigation", { name: "Workspace sessions", exact: true })
    .locator(".workspace-tab");

test("lists one row per workspace with its sessions as tabs", async ({ page }) => {
  await page.goto("/");
  await expect(heading(page, "Coordinate the release")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w1/session/root");

  // Two workspaces, each named after the session that started it.
  await expect(sidebar(page).locator(".workspace-row")).toHaveCount(2);
  await expect(sidebar(page)).not.toContainText("Write the migration");
  await expect(sidebar(page)).not.toContainText("Investigate the flaky test");
  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).first()).toHaveText("Coordinate the release");
  await expect(tabs(page).last()).toHaveText("Write the migration");

  // A tab opens its session in the same workspace.
  await tabs(page).last().click();
  await expect(heading(page, "Write the migration")).toBeVisible();
  await expect(page.getByText("Prompt for sibling")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w1/session/sibling");
  await expect(sidebar(page).locator(".workspace-row.active")).toHaveText(/Coordinate the release/);

  // A row opens the session that started its workspace, and history follows.
  await sidebar(page)
    .locator(".workspace-row")
    .filter({ hasText: "Polish the settings page" })
    .click();
  await expect(heading(page, "Polish the settings page")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w2/session/other");
  await expect(tabs(page)).toHaveCount(1);

  await page.evaluate(() => history.back());
  await expect(heading(page, "Write the migration")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w1/session/sibling");

  await page.evaluate(() => history.forward());
  await expect(heading(page, "Polish the settings page")).toBeVisible();
});

test("opens workspace and session links, spawned sessions in their root's workspace", async ({
  page,
}) => {
  // Not the most recent workspace, which opens by default.
  await page.goto("/workspace/w2");
  await expect(heading(page, "Polish the settings page")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w2/session/other");

  await page.goto("/workspace/w1/session/child");
  await expect(heading(page, "Investigate the flaky test")).toBeVisible();
  await expect(page.getByText("Prompt for child")).toBeVisible();
  // Its workspace stays lit, with the tab it was spawned from.
  await expect(sidebar(page).locator(".workspace-row.active")).toHaveText(/Coordinate the release/);
  await expect(page.locator(".workspace-tab.active")).toHaveText("Coordinate the release");
  await expect.poll(() => path(page)).toBe("/workspace/w1/session/child");

  await page.reload();
  await expect(heading(page, "Investigate the flaky test")).toBeVisible();

  // Bare and mis-scoped links are rewritten to the session's workspace.
  for (const link of ["/session/child", "/workspace/w2/session/child"]) {
    await page.goto(link);
    await expect(heading(page, "Investigate the flaky test")).toBeVisible();
    await expect.poll(() => path(page)).toBe("/workspace/w1/session/child");
  }
});

test("starts a session in the open workspace", async ({ page }) => {
  await page.goto("/workspace/w1/session/root");
  await expect(heading(page, "Coordinate the release")).toBeVisible();

  await page.getByRole("button", { name: "New session in this workspace", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New session in Coordinate the release" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Task", { exact: true }).fill("Backfill the audit log");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(heading(page, "Backfill the audit log")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w1/session/new");
  expect(created.map((body) => body.workspaceId)).toEqual(["w1"]);
  await expect(tabs(page)).toHaveCount(3);
  await expect(tabs(page).last()).toHaveText("Backfill the audit log");
  await expect(sidebar(page).locator(".workspace-row")).toHaveCount(2);
});

test("archives and restores a whole workspace", async ({ page }) => {
  await page.goto("/workspace/w1/session/root");
  await expect(heading(page, "Coordinate the release")).toBeVisible();

  const row = sidebar(page)
    .locator(".workspace-item")
    .filter({ hasText: "Coordinate the release" });

  await row.hover();
  await row
    .getByRole("button", { name: "Archive workspace: Coordinate the release", exact: true })
    .click();
  // Its own sessions are archived; the spawned one goes with its parent.
  await expect.poll(() => updates.length).toBe(2);
  expect(updates).toContainEqual({ id: "root", archived: true });
  expect(updates).toContainEqual({ id: "sibling", archived: true });
  await expect(heading(page, "Polish the settings page")).toBeVisible();
  await expect(sidebar(page).locator(".workspace-row")).toHaveCount(1);

  await page.getByRole("button", { name: "Archived workspaces (1)", exact: true }).click();
  await expect(sidebar(page)).toContainText("Coordinate the release");
});

test("the feed has its own URL that survives reloads and history", async ({ page }) => {
  await page.goto("/workspace/w2/session/other");
  await expect(heading(page, "Polish the settings page")).toBeVisible();

  const link = page.getByRole("link", { name: "Feed", exact: true });
  await expect(link).toHaveAttribute("href", "/feed");
  await link.click();
  await expect(heading(page, "Feed")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/feed");
  await expect(sidebar(page).locator(".workspace-row.active")).toHaveCount(0);

  // A reload stays on the feed rather than jumping to a session.
  await page.reload();
  await expect(heading(page, "Feed")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/feed");

  // Back returns to the session; forward to the feed.
  await page.evaluate(() => history.back());
  await expect(heading(page, "Polish the settings page")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w2/session/other");
  await page.evaluate(() => history.forward());
  await expect(heading(page, "Feed")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/feed");

  // Choosing the session that was open behind the feed still leaves it.
  await page.locator(".feed-list button").filter({ hasText: "Polish the settings page" }).click();
  await expect(heading(page, "Polish the settings page")).toBeVisible();
  await expect.poll(() => path(page)).toBe("/workspace/w2/session/other");
});
