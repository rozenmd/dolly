import { expect, test } from "@playwright/test";

test("desktop preview, search, activity, details, and keyboard dialog", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Add multiplayer workspace presence",
  );
  await expect(
    page.getByText("Presence now appears in every shared workspace", { exact: false }),
  ).toBeVisible();
  await page.getByRole("searchbox").fill("keyboard");
  await expect(
    page.getByRole("navigation", { name: "Workspaces" }).getByRole("button"),
  ).toHaveCount(1);
  await page.getByRole("searchbox").fill("no matching title");
  await expect(page.getByText("No matching workspaces.")).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Toggle session details" }).click();
  await expect(page.getByRole("complementary", { name: "Session details" })).toBeVisible();
  await page.getByRole("button", { name: "Toggle session details" }).click();
  await page.getByRole("button", { name: "Activity feed" }).click();
  await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
  await page.getByRole("button", { name: "Connect your API" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Connect your API" })).toBeFocused();
  expect(errors).toEqual([]);
});

test("mobile navigation and 320px layout", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  await page.getByRole("button", { name: /Ship keyboard shortcuts/ }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ship keyboard shortcuts");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("authenticated create, send, stop, reload, and error recovery", async ({ page }) => {
  const token = "test-token-with-at-least-32-characters";
  const entries: { id: string; kind: string; model: { role: string; content: string }[] }[] = [];
  const requestIds: string[] = [];
  let failMessage = true;
  let stopped = false;
  await page.route("**/api/**", async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/integrations/github") return route.fulfill({ json: { connected: true } });

    if (path === "/api/sessions")
      return route.fulfill({ status: 201, json: { id: "test-session", model: "gpt-6-sol" } });

    if (path.endsWith("/messages")) {
      const body = route.request().postDataJSON();
      requestIds.push(body.requestId);

      if (failMessage) {
        failMessage = false;

        return route.fulfill({ status: 502, json: { error: "Temporary failure. Try again." } });
      }

      entries.push({
        id: "entry-1",
        kind: "pi.input",
        model: [{ role: "user", content: body.content }],
      });

      return route.fulfill({ status: 202, json: { submissionId: "submission-1" } });
    }

    if (path.endsWith("/abort")) {
      stopped = true;

      return route.fulfill({ json: { ok: true } });
    }

    return route.fulfill({ json: { entries, docs: {} } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect your API" }).click();
  await page.getByLabel("API token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect API", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Fix flaky tests");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix flaky tests");
  await page.getByLabel("Message your agent").fill("Run tests");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Temporary failure. Try again.");
  await expect(page.getByLabel("Message your agent")).toHaveValue("Run tests");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await expect(page.getByRole("article", { name: "user message" })).toContainText("Run tests");
  await page.getByRole("button", { name: "Stop agent" }).click();
  expect(stopped).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
  await page.reload();
  await expect(page.getByText("Preview mode", { exact: true })).toBeVisible();
});
