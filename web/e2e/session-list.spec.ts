import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    if (localStorage.getItem("dolly.sessions.v1")) return;
    localStorage.setItem(
      "dolly.sessions.v1",
      JSON.stringify(
        Array.from({ length: 8 }, (_, index) => ({
          id: `session-${index}`,
          title: `Task ${index}`,
          model: "gpt-6-sol",
          repository: "",
          updatedAt: index,
        })),
      ),
    );
  });
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/auth")
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
