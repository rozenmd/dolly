import { expect, test } from "./browser";

type Feed = { send(message: string): void; close(): void };

/** The sidebar's change feed as the page opened it, once it has. */
let feeds: Feed[] = [];
let state = "open";
let lists = 0;

test.beforeEach(async ({ page }) => {
  feeds = [];
  state = "open";
  lists = 0;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions") {
      lists += 1;

      return route.fulfill({
        json: [
          {
            id: "fix",
            title: "Fix the flaky test",
            model: "gpt-6-sol",
            repository: "octocat/project",
            updatedAt: 1,
            archived: false,
            pullRequest: {
              repository: "octocat/project",
              number: 8,
              url: "https://github.com/octocat/project/pull/8",
              state,
            },
          },
        ],
      });
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
  await page.routeWebSocket("**/api/sessions/*/events", (socket) =>
    socket.send(JSON.stringify({ entries: [], docs: {} })),
  );
  await page.routeWebSocket("**/api/events", (socket) => {
    feeds.push(socket);
  });
  await page.goto("/");
});

test("an announced change updates the sidebar at once, without waiting for the poll", async ({
  page,
}) => {
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(workspaces.getByLabel("Pull request open #8")).toBeVisible();
  await expect.poll(() => feeds.length).toBe(1);
  const before = lists;

  state = "merged";
  feeds[0].send(JSON.stringify({ type: "sessions" }));
  await expect(workspaces.getByLabel("Pull request merged #8")).toBeVisible();
  expect(lists).toBe(before + 1);
});

test("a reconnected feed catches up on changes it missed", async ({ page }) => {
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(workspaces.getByLabel("Pull request open #8")).toBeVisible();
  await expect.poll(() => feeds.length).toBe(1);

  // Merged while the feed was down: nothing announced it.
  state = "merged";
  feeds[0].close();
  await expect.poll(() => feeds.length, { timeout: 4000 }).toBe(2);
  await expect(workspaces.getByLabel("Pull request merged #8")).toBeVisible();
});
