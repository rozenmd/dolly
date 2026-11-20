import { expect, test } from "./browser";

const github = {
  connected: true,
  owner: "octocat",
  appSlug: "dolly-test",
  installUrl: "https://github.com/apps/dolly-test/installations/new",
  settingsUrl: "https://github.com/settings/apps/dolly-test",
  ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  senders: ["octocat"],
};

const repository = {
  fullName: "octocat/project",
  defaultBranch: "main",
  private: false,
  description: null,
  registered: true,
};

for (const width of [1280, 390])
  test(`starts a session that pushes to the branch a person names at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const created: { workspace?: { repository?: string; ref?: string; branch?: string } }[] = [];

    await page.routeWebSocket("**/api/sessions/*/events", (socket) => {
      socket.send(JSON.stringify({ entries: [], docs: {} }));
    });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === "/api/auth")
        return route.fulfill({ json: { ownerClaimed: true, user: { login: "octocat" }, github } });

      if (path === "/api/auth/chatgpt") return route.fulfill({ json: { state: "connected" } });

      if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

      if (path === "/api/integrations/github/repositories")
        return route.fulfill({ json: { repositories: [repository] } });

      if (path === "/api/sessions" && route.request().method() === "POST") {
        created.push(route.request().postDataJSON());

        return route.fulfill({ status: 201, json: { id: "branch", model: "gpt-6-luna" } });
      }

      return route.fulfill({ json: {} });
    });

    await page.goto("/", { waitUntil: "networkidle" });
    const dialog = page.getByRole("dialog", { name: "New session" });
    const branch = dialog.getByLabel("Push branch", { exact: true });

    // Without a repository there is nothing to push to.
    await expect(branch).toHaveCount(0);
    await dialog.getByRole("button", { name: "Repository" }).click();
    await page.getByRole("option", { name: /project/ }).click();
    await expect(branch).toHaveValue("");
    await branch.fill("  investigate-audit-headers-null ");
    await dialog.getByLabel("Task", { exact: true }).fill("Fix the null audit headers");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // The branch replaces the default-branch ref, so the checkout starts from it.
    expect(created[0]).toMatchObject({
      workspace: { repository: "octocat/project", branch: "investigate-audit-headers-null" },
    });
    expect(created[0].workspace?.ref).toBeUndefined();
  });
