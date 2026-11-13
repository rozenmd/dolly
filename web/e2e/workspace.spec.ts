import { expect, test } from "@playwright/test";

test("disconnected workspace has no placeholder content and opens the connect dialog", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("pi-hard");
  await expect(
    page.getByRole("navigation", { name: "Workspaces" }).getByRole("button"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Feed" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Feed");
  await page.getByRole("button", { name: "Connection settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Connection settings" })).toBeFocused();
  expect(errors).toEqual([]);
});

test("mobile navigation and 320px layout", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Feed" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Feed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("authenticated create, send, stop, reload, and error recovery", async ({ page }) => {
  const token = "test-token-with-at-least-32-characters";
  const entries: { id: string; kind: string; model: { role: string; content: string }[] }[] = [];
  let working = false;
  const requestIds: string[] = [];
  let failMessage = true;
  let stopped = false;
  await page.route("**/api/**", async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/integrations/github") return route.fulfill({ json: { connected: true } });

    if (path === "/api/auth/codex") return route.fulfill({ json: { state: "connected" } });

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

      working = true;

      return route.fulfill({ status: 202, json: { submissionId: "submission-1" } });
    }

    if (path.endsWith("/abort")) {
      stopped = true;

      return route.fulfill({ json: { ok: true } });
    }

    return route.fulfill({ json: { entries, docs: working ? { "pi.live": { run: {} } } : {} } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("API token", { exact: true }).fill(token);
  await page.getByRole("dialog").getByRole("button", { name: "Connect", exact: true }).click();
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
  await expect.poll(() => stopped).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect to pi-hard" })).toBeVisible();
});

test("ChatGPT device sign-in shows the code, polls until approved, then opens a new workspace", async ({
  page,
}) => {
  const token = "test-token-with-at-least-32-characters";
  const calls: string[] = [];
  let polls = 0;

  const awaiting = {
    state: "awaiting_code",
    verificationUri: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
    expiresAt: Date.now() + 900_000,
    pollAfterSeconds: 1,
  };

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/integrations/github") return route.fulfill({ json: { connected: true } });

    if (path !== "/api/auth/codex") return route.fulfill({ status: 404, json: { error: "x" } });

    calls.push(method);

    if (method === "POST") return route.fulfill({ json: awaiting });

    if (calls.filter((call) => call === "POST").length === 0)
      return route.fulfill({ json: { state: "not_connected" } });

    polls += 1;

    if (polls === 2) return route.fulfill({ status: 502, json: { error: "Temporary failure" } });

    return route.fulfill({ json: polls < 3 ? awaiting : { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("API token", { exact: true }).fill(token);
  await page.getByRole("dialog").getByRole("button", { name: "Connect", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to ChatGPT" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(page.getByRole("button", { name: "Copy code ABCD-1234" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open ChatGPT" })).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  await expect(page.getByRole("dialog", { name: "New workspace" })).toBeVisible({
    timeout: 10_000,
  });
  expect(polls).toBe(3);
});
