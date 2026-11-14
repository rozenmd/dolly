import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  let sessions = Array.from({ length: 8 }, (_, index) => ({
    id: `session-${index}`,
    title: `Task ${index}`,
    model: "gpt-6-sol",
    repository: "",
    updatedAt: index,
    archived: false,
  }));

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions") return route.fulfill({ json: sessions });

    if (path.startsWith("/api/sessions/") && route.request().method() === "PUT") {
      const id = path.split("/").at(-1);
      const { archived } = route.request().postDataJSON();
      sessions = sessions.map((session) =>
        session.id === id ? { ...session, archived } : session,
      );

      return route.fulfill({ json: { archived } });
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
  await page.goto("/");
});

test("loads server sessions on mobile with empty browser storage", async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Task 7", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(workspaces.locator(".workspace-row")).toHaveCount(5);
  await page.getByRole("button", { name: "Show older (3)", exact: true }).click();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(8);
  await workspaces.locator(".workspace-row").filter({ hasText: "Task 0" }).click();
  await expect(page.getByRole("heading", { name: "Task 0", exact: true })).toBeVisible();
});

test("refreshes on focus and retains sessions if syncing fails", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Task 7", exact: true })).toBeVisible();
  await page.route("**/api/sessions", (route) =>
    route.fulfill({ status: 503, json: { error: "Server unavailable" } }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Could not sync sessions");
  await expect(page.getByRole("heading", { name: "Task 7", exact: true })).toBeVisible();
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      json: [
        {
          id: "another-device",
          title: "Created on desktop",
          model: "gpt-6-sol",
          repository: "",
          updatedAt: Date.now(),
          archived: false,
        },
      ],
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.locator(".workspace-row").filter({ hasText: "Created on desktop" }),
  ).toBeVisible();
});

test("archives and restores sessions across reloads, with older sessions discoverable", async ({
  page,
}) => {
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(page.getByRole("heading", { name: "Task 7", exact: true })).toBeVisible();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(5);
  await page.getByRole("button", { name: "Show older (3)", exact: true }).click();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(8);
  await page.getByRole("button", { name: "Hide older", exact: true }).click();
  await page.getByRole("button", { name: "Search workspaces", exact: true }).click();
  await page.getByRole("searchbox").fill("Task 0");
  await expect(workspaces.locator(".workspace-row")).toHaveCount(1);
  await expect(workspaces).toContainText("Task 0");
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Archive session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Task 6", exact: true })).toBeVisible();
  await expect(workspaces).not.toContainText("Task 7");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Task 6", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archived sessions (1)", exact: true }).click();
  await expect(workspaces.getByRole("button")).toHaveCount(1);
  await workspaces.getByRole("button", { name: /Task 7/ }).click();
  await page.getByRole("button", { name: "Restore session", exact: true }).click();
  await page.getByRole("button", { name: "Back to recent", exact: true }).click();
  await expect(workspaces).toContainText("Task 7");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Task 7", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Archived sessions (0)", exact: true }),
  ).toBeVisible();
});

test("archives sidebar sessions on hover or keyboard focus without opening them", async ({
  page,
}) => {
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  const row = workspaces.locator(".workspace-item").filter({ hasText: "Task 6" });
  const archive = row.getByRole("button", { name: "Archive session: Task 6", exact: true });

  await expect(page.getByRole("heading", { name: "Task 7", exact: true })).toBeVisible();
  await expect(archive).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(archive).toHaveCSS("opacity", "1");
  await archive.click();
  await expect(workspaces).not.toContainText("Task 6");
  await expect(page.getByRole("heading", { name: "Task 7", exact: true })).toBeVisible();

  const selectedRow = workspaces.locator(".workspace-item").filter({ hasText: "Task 7" });

  await page.mouse.move(1000, 700);
  await selectedRow.locator(".workspace-row").focus();

  const selectedArchive = selectedRow.getByRole("button", {
    name: "Archive session: Task 7",
    exact: true,
  });

  await expect(selectedArchive).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(selectedArchive).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Task 5", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Task 5", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archived sessions (2)", exact: true }).click();
  await expect(workspaces).toContainText("Task 6");
  await expect(workspaces).toContainText("Task 7");
});
