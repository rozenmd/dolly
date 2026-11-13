import { expect, test, type Page } from "@playwright/test";

const app = {
  connected: true,
  owner: "octocat",
  appSlug: "dolly-test",
  installUrl: "https://github.com/apps/dolly-test/installations/new",
  settingsUrl: "https://github.com/settings/apps/dolly-test",
  ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  senders: ["octocat"],
};

const signedIn = { github: app, ownerClaimed: true, user: { login: "octocat" } };

/** A browser that is already signed in with GitHub and ChatGPT, with no saved workspaces. */
async function signedInWorkspace(page: Page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    return route.fulfill({ json: { state: "connected" } });
  });
}

test("first run creates the GitHub App from dolly with the ingress URL filled in", async ({
  page,
}) => {
  const errors: string[] = [];
  let setup: unknown;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({
        json: { github: { connected: false }, ownerClaimed: false, user: null },
      });

    if (path === "/api/integrations/github/setup") {
      setup = route.request().postDataJSON();

      return route.fulfill({
        json: { connected: false, setupUrl: "http://127.0.0.1:3000/api/setup/github/test-state" },
      });
    }

    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Connect GitHub</title><h1>Create GitHub App</h1>",
    });
  });
  await page.goto("/?github=GitHub%20App%20owner%20does%20not%20match", {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("heading", { name: "Set up dolly" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("GitHub App owner does not match");
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByText("API token")).toHaveCount(0);
  await page.getByLabel("Your GitHub username").fill("octocat");
  await page.getByLabel("Ingress URL").fill("https://dolly-ingress.example.workers.dev/");
  await page.getByRole("button", { name: "Create GitHub App" }).click();
  await expect(page.getByRole("heading", { name: "Create GitHub App" })).toBeVisible();
  expect(setup).toEqual({
    owner: "octocat",
    ownerType: "personal",
    ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  });
  expect(errors).toEqual([]);
});

test("GitHub device sign-in claims dolly, then continues to ChatGPT", async ({ page }) => {
  let polls = 0;

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: false, user: null } });

    if (path === "/api/auth/github" && method === "POST")
      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://github.com/login/device",
          userCode: "WDJB-MJHT",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });

    if (path === "/api/auth/github") {
      polls += 1;

      if (polls === 1)
        return route.fulfill({ status: 502, json: { error: "Request failed; check Worker logs" } });

      return route.fulfill({ json: { state: "signed_in", login: "octocat" } });
    }

    return route.fulfill({ json: { state: "not_connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to dolly" })).toBeVisible();
  await expect(page.getByRole("link", { name: "its settings" })).toHaveAttribute(
    "href",
    app.settingsUrl,
  );
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("button", { name: "Copy code WDJB-MJHT" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/login/device",
  );
  await expect(page.getByRole("dialog", { name: "Sign in to ChatGPT" })).toBeVisible({
    timeout: 10_000,
  });
  expect(polls).toBe(2);
});

test("GitHub sign-in as someone other than the owner is refused with the reason", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: true, user: null } });

    if (method === "POST")
      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://github.com/login/device",
          userCode: "WDJB-MJHT",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });

    return route.fulfill({
      status: 403,
      json: {
        state: "denied",
        message: "You signed in as @intruder, but this dolly belongs to @octocat.",
      },
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "You signed in as @intruder, but this dolly belongs to @octocat.",
  );
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("device flow turned off links straight to the GitHub App's settings", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: true, user: null } });

    return route.fulfill({
      status: 409,
      json: { error: "Device flow is turned off for this GitHub App, so nobody can sign in." },
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("link", { name: "Open the app's settings" })).toHaveAttribute(
    "href",
    app.settingsUrl,
  );
});

test("settings show who is signed in and update the ingress URL and GitHub access", async ({
  page,
}) => {
  let ingress: unknown;
  let accounts: unknown;
  let senders: unknown;
  let signedOut = false;

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/integrations/github/ingress") {
      ingress = route.request().postDataJSON();

      return route.fulfill({ json: { ingress: "https://new-ingress.example/hooks/github" } });
    }

    if (path === "/api/integrations/github/accounts") {
      if (route.request().method() === "PUT") accounts = route.request().postDataJSON();

      return route.fulfill({ json: { accounts: ["octocat"] } });
    }

    if (path === "/api/integrations/github/webhook") {
      senders = route.request().postDataJSON();

      return route.fulfill({ json: { configured: true } });
    }

    if (path === "/api/auth/session") {
      signedOut = true;

      return route.fulfill({ json: { signedIn: false } });
    }

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toContainText("Signed in as @octocat");
  await expect(dialog.getByRole("link", { name: "Add repositories" })).toHaveAttribute(
    "href",
    app.installUrl,
  );
  await dialog.getByLabel("Ingress URL").fill("https://new-ingress.example");
  await dialog.getByRole("button", { name: "Save" }).first().click();
  await expect(dialog).toContainText("GitHub now sends comments to this URL.");
  expect(ingress).toEqual({ url: "https://new-ingress.example/hooks/github" });
  await expect(dialog.getByLabel("Accounts dolly can work in")).toHaveValue("octocat");
  await expect(dialog.getByLabel("Who can run /pi commands")).toHaveValue("octocat");
  await dialog.getByLabel("Accounts dolly can work in").fill("octocat, @acme");
  await dialog.getByLabel("Who can run /pi commands").fill("octocat hubot");
  await dialog.getByRole("button", { name: "Save" }).last().click();
  await expect(dialog.getByText("Saved.", { exact: true })).toBeVisible();
  expect(accounts).toEqual({ accounts: ["octocat", "acme"] });
  expect(senders).toEqual({ senders: ["octocat", "hubot"] });
  // Reopening shows what was saved, and clearing the list saves an empty list.
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(dialog.getByLabel("Who can run /pi commands")).toHaveValue("octocat, hubot");
  await dialog.getByLabel("Who can run /pi commands").fill("");
  await dialog.getByRole("button", { name: "Save" }).last().click();
  await expect(dialog.getByText("Saved.", { exact: true })).toBeVisible();
  expect(senders).toEqual({ senders: [] });
  await dialog.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("heading", { name: "Sign in to dolly" })).toBeVisible();
  expect(signedOut).toBe(true);
});

test("mobile navigation and 320px layout", async ({ page }) => {
  await signedInWorkspace(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
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
  const entries: { id: string; kind: string; model: { role: string; content: string }[] }[] = [];
  let working = false;
  const requestIds: string[] = [];
  let failMessage = true;
  let stopped = false;
  await page.route("**/api/**", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

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
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix flaky tests");
});

test("ChatGPT device sign-in shows the code, polls until approved, then opens a new workspace", async ({
  page,
}) => {
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

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

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

test("cancelling ChatGPT sign-in ignores an approval that was already in flight", async ({
  page,
}) => {
  let started = false;
  let deleted = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (method === "DELETE") {
      deleted = true;
      // The Worker serialises DELETE behind the approval already holding the account lock.
      await held;
      await new Promise((resolve) => setTimeout(resolve, 300));

      return route.fulfill({ json: { state: "not_connected" } });
    }

    if (method === "POST") {
      started = true;

      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });
    }

    if (!started) return route.fulfill({ json: { state: "not_connected" } });

    await held;

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "Sign in to ChatGPT" });
  await dialog.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(dialog.getByRole("button", { name: "Copy code ABCD-1234" })).toBeVisible();
  await page.waitForTimeout(1_500);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => deleted).toBe(true);
  release();
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to ChatGPT" })).toBeVisible();
});
