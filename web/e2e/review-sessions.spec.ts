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
    // An older review, with writable work the owner started in its workspace.
    {
      id: "review-2",
      title: "Review example/project#9",
      updatedAt: now - 180_000,
      createdAt: now - 180_000,
      automation: "review",
    },
    {
      id: "fix-1",
      title: "Fix review feedback",
      updatedAt: now - 240_000,
      createdAt: now - 170_000,
      workspaceId: "review-2",
    },
  ].map((session) => ({ model: "gpt-6-sol", repository: "", archived: false, ...session }));

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions") return route.fulfill({ json: sessions });

    if (path.startsWith("/api/sessions/") && route.request().method() === "PUT") {
      const id = path.split("/").at(-1);
      const body = route.request().postDataJSON();

      const session: { archived: boolean; pinnedAt?: number } | undefined = sessions.find(
        (item) => item.id === id,
      );

      if (session && "archived" in body) session.archived = body.archived;

      if (session && "pinned" in body) {
        if (body.pinned) session.pinnedAt = 1_000;
        else delete session.pinnedAt;
      }

      return route.fulfill({ json: { ...body, ...(body.pinned && { pinnedAt: 1_000 }) } });
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
  // A review's workspace stays listed once writable work was started in it.
  await expect(workspaces.locator(".workspace-row")).toHaveCount(3);
  await expect(workspaces).not.toContainText("Review example/project#8");
  // It is named after, and opens, that work rather than the review.
  await expect(workspaces).not.toContainText("Review example/project#9");
  await workspaces.locator(".workspace-row").filter({ hasText: "Fix review feedback" }).click();
  await expect(
    page.getByRole("heading", { name: "Fix review feedback", exact: true }),
  ).toBeVisible();
});

test("shows an open review's row until another session is opened", async ({ page }) => {
  await page.goto("/workspace/review-1/session/review-1");

  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });

  await expect(
    page.getByRole("heading", { name: "Review example/project#8", exact: true }),
  ).toBeVisible();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(4);
  await expect(workspaces.locator(".workspace-row.active")).toContainText(
    "Review example/project#8",
  );

  await workspaces.locator(".workspace-row").filter({ hasText: "Fix the flaky test" }).click();
  await expect(
    page.getByRole("heading", { name: "Fix the flaky test", exact: true }),
  ).toBeVisible();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(3);
  await expect(workspaces).not.toContainText("Review example/project#8");
});

test("a pinned review stays in the sidebar after another session is opened", async ({ page }) => {
  await page.goto("/workspace/review-1/session/review-1");

  const pinned = page.getByRole("navigation", { name: "Pinned workspaces", exact: true });
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });

  await expect(
    page.getByRole("heading", { name: "Review example/project#8", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pin workspace", exact: true }).click();
  await expect(pinned).toContainText("Review example/project#8");

  await workspaces.locator(".workspace-row").filter({ hasText: "Fix the flaky test" }).click();
  await expect(
    page.getByRole("heading", { name: "Fix the flaky test", exact: true }),
  ).toBeVisible();
  await expect(pinned).toContainText("Review example/project#8");

  // Another device, which never opened the review, lists it too.
  await page.goto("/workspace/task-2/session/task-2");
  await expect(
    page.getByRole("heading", { name: "Fix the flaky test", exact: true }),
  ).toBeVisible();
  await expect(pinned).toContainText("Review example/project#8");
});

test("archiving the writable tab in a review's workspace does not open the review", async ({
  page,
}) => {
  await page.goto("/workspace/review-2/session/fix-1");
  await expect(
    page.getByRole("heading", { name: "Fix review feedback", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Archive session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ship the feature", exact: true })).toBeVisible();

  // The workspace moves from Recent to Archived; its unarchived review doesn't hold it back.
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });

  await expect(workspaces).not.toContainText("Fix review feedback");
  await page.getByRole("button", { name: "Archived workspaces (1)", exact: true }).click();
  await expect(workspaces).toContainText("Fix review feedback");
});
