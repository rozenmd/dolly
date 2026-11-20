import { expect, test } from "./browser";

const github = {
  connected: true,
  owner: "octocat",
  appSlug: "dolly-test",
  installUrl: "https://github.com/apps/dolly-test/installations/new",
  settingsUrl: "https://github.com/settings/apps/dolly-test",
  ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  senders: ["octocat"],
  reviews: false,
};

const signedIn = { github, ownerClaimed: true, user: { login: "octocat" } };

type SetupState = {
  accounts: string[];
  installations: { login: string; allowed: boolean }[];
  enrolled: number;
  missingPermissions: string[];
  missingEvents: string[];
};

const installation = {
  login: "octocat",
  pendingApproval: false,
  settingsUrl: "https://github.com/settings/installations/7",
};

for (const width of [1280, 390]) {
  test(`walks a new owner from installing the App to enrolling repositories at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });

    let state: SetupState = {
      accounts: [],
      installations: [],
      enrolled: 0,
      missingPermissions: [],
      missingEvents: ["check_run", "workflow_run"],
    };

    const puts: unknown[] = [];

    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === "/api/auth") return route.fulfill({ json: signedIn });

      if (path === "/api/integrations/github/onboarding")
        return route.fulfill({
          json: {
            ...state,
            installations: state.installations.map((item) => ({ ...installation, ...item })),
          },
        });

      if (path === "/api/integrations/github/accounts" && route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        puts.push(body);
        state = {
          ...state,
          accounts: ["octocat"],
          installations: [{ login: "octocat", allowed: true }],
        };

        return route.fulfill({ json: body });
      }

      return route.fulfill({ json: { state: "connected" } });
    });
    await page.goto("/", { waitUntil: "networkidle" });
    // With a model connected and no sessions, the composer opens first; the checklist is behind it.
    await page.getByRole("dialog", { name: "New session" }).press("Escape");

    const checklist = page.getByRole("region", { name: "Get dolly ready" });
    await expect(checklist).toBeVisible();
    await expect(checklist.getByText("Connect a model (done)")).toBeVisible();
    await expect(checklist.getByRole("link", { name: "Install" })).toHaveAttribute(
      "href",
      github.installUrl,
    );
    // An older App is told exactly which settings to tick.
    await expect(checklist.getByRole("status")).toContainText("check_run, workflow_run");
    await expect(checklist.getByRole("link", { name: "App settings" })).toHaveAttribute(
      "href",
      github.settingsUrl,
    );
    await page.screenshot({ path: test.info().outputPath(`install-${width}.png`) });

    // Installing happens on github.com; coming back to the tab refreshes the checklist.
    state = { ...state, installations: [{ login: "octocat", allowed: false }] };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(checklist.getByText("Installed on octocat.")).toBeVisible();
    await checklist.getByRole("button", { name: "Allow octocat" }).click();
    await expect(checklist.getByText("Agents may work in octocat.")).toBeVisible();
    expect(puts).toEqual([{ accounts: ["octocat"] }]);
    await expect(checklist.getByRole("link", { name: "Choose" })).toHaveAttribute(
      "href",
      "/settings/repositories",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`enroll-${width}.png`) });

    state = { ...state, enrolled: 2 };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(checklist).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No workspace selected" })).toBeVisible();
  });
}

test("keeps the plain empty state when setup status is unavailable", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/integrations/github/onboarding")
      return route.fulfill({ status: 409, json: { error: "GitHub is unavailable" } });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "New session" }).press("Escape");
  await expect(page.getByRole("heading", { name: "No workspace selected" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Get dolly ready" })).toHaveCount(0);
});
