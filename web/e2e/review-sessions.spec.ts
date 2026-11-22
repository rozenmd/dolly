import { expect, test } from "./browser";

// Automatic pull request reviews stay out of the sidebar, after OpenSession; the open one keeps
// its row while it is open.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  const now = Date.now();

  const sessions = [
    { id: "review-1", title: "Review example/project#8", updatedAt: now, automation: "review" },
    { id: "task-1", title: "Ship the feature", updatedAt: now - 60_000 },
    { id: "task-2", title: "Fix the flaky test", updatedAt: now - 120_000 },
  ].map((session) => ({ model: "gpt-6-sol", repository: "", archived: false, ...session }));

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
            reviews: true,
          },
          ownerClaimed: true,
          user: { login: "octocat" },
        },
      });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/*/events", (socket) =>
    socket.send(JSON.stringify({ entries: [], docs: {} })),
  );
});

test("leaves automatic reviews out of the sidebar and never opens on one", async ({ page }) => {
  await page.goto("/");

  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });

  // The newest session is a review, so the app opens on the newest of the others.
  await expect(page.getByRole("heading", { name: "Ship the feature", exact: true })).toBeVisible();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(2);
  await expect(workspaces).not.toContainText("Review example/project#8");
});

test("shows an open review's row until another session is opened", async ({ page }) => {
  await page.goto("/workspace/review-1/session/review-1");

  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });

  await expect(
    page.getByRole("heading", { name: "Review example/project#8", exact: true }),
  ).toBeVisible();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(3);
  await expect(workspaces.locator(".workspace-row.active")).toContainText(
    "Review example/project#8",
  );

  await workspaces.locator(".workspace-row").filter({ hasText: "Fix the flaky test" }).click();
  await expect(
    page.getByRole("heading", { name: "Fix the flaky test", exact: true }),
  ).toBeVisible();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(2);
  await expect(workspaces).not.toContainText("Review example/project#8");
});
