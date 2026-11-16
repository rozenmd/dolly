import { expect, test } from "./browser";

// Spawned sessions follow opensession: kept out of the sidebar, reached from their parent.
const now = Date.now();

const pull = (number: number, state: "open" | "merged") => ({
  repository: "octocat/project",
  number,
  url: `https://github.com/octocat/project/pull/${number}`,
  state,
});

const fixture = [
  {
    id: "root",
    title: "Coordinate the release",
    model: "gpt-6-sol",
    repository: "octocat/project",
    updatedAt: now,
    archived: false,
  },
  {
    id: "flaky",
    parentId: "root",
    title: "Investigate the flaky test",
    model: "gpt-6-sol",
    repository: "octocat/project",
    updatedAt: now - 1_000,
    archived: false,
    running: true,
  },
  {
    id: "sdk",
    parentId: "root",
    title: "Bump the SDK",
    model: "gpt-6-sol",
    repository: "octocat/project",
    updatedAt: now - 2_000,
    archived: false,
    pullRequest: pull(42, "merged"),
  },
  {
    id: "logs",
    parentId: "flaky",
    title: "Read the CI logs",
    model: "gpt-6-sol",
    repository: "octocat/project",
    updatedAt: now - 3_000,
    archived: false,
  },
  {
    id: "docs",
    parentId: "root",
    kept: true,
    title: "Fix the docs",
    model: "gpt-6-sol",
    repository: "octocat/project",
    updatedAt: now - 4_000,
    archived: false,
    pullRequest: pull(43, "open"),
  },
  {
    id: "settings",
    title: "Polish the settings page",
    model: "gpt-6-sol",
    repository: "",
    updatedAt: now - 5_000,
    archived: false,
  },
];

const spawnCall = (id: string, content: string) => ({
  type: "toolCall",
  id: `call-${id}`,
  name: "spawn_task",
  arguments: { content },
});

const spawnResult = (id: string) => ({
  role: "toolResult",
  toolCallId: `call-${id}`,
  toolName: "spawn_task",
  content: [
    { type: "text", text: JSON.stringify({ id, model: "gpt-6-sol", taskId: `task-${id}` }) },
  ],
});

const rootTranscript = {
  entries: [
    {
      id: 1,
      kind: "pi.user",
      model: [{ role: "user", content: "Coordinate the release", timestamp: now - 60_000 }],
    },
    {
      id: 2,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [
            spawnCall("flaky", "Investigate the flaky test"),
            spawnCall("sdk", "Bump the SDK"),
          ],
          timestamp: now - 59_000,
        },
        spawnResult("flaky"),
        spawnResult("sdk"),
        {
          role: "assistant",
          content: "I started two threads and will report back.",
          timestamp: now - 58_000,
        },
      ],
    },
  ],
  docs: {},
};

let sessions: typeof fixture = [];
let updates: unknown[] = [];

test.beforeEach(async ({ page }) => {
  sessions = structuredClone(fixture);
  updates = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions") return route.fulfill({ json: sessions });

    if (path.startsWith("/api/sessions/") && route.request().method() === "PUT") {
      const id = path.split("/").at(-1);
      const body = route.request().postDataJSON();
      updates.push({ id, ...body });
      sessions = sessions.map((session) => (session.id === id ? { ...session, ...body } : session));

      return route.fulfill({ json: body });
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
  await page.routeWebSocket("**/api/sessions/*/events", (socket) => {
    const id = new URL(socket.url()).pathname.split("/").at(-2);

    socket.send(JSON.stringify(id === "root" ? rootTranscript : { entries: [], docs: {} }));
  });
  await page.goto("/");
});

const shots = process.env.SCREENSHOT_DIR;

test("keeps spawned sessions out of the sidebar and shows them with their parent", async ({
  page,
}) => {
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(
    page.getByRole("heading", { name: "Coordinate the release", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("I started two threads and will report back.")).toBeVisible();

  // Only top-level sessions and the one the owner kept get rows.
  await expect(workspaces.locator(".workspace-row")).toHaveCount(3);
  await expect(workspaces).toContainText("Coordinate the release");
  await expect(workspaces).toContainText("Fix the docs");
  await expect(workspaces).toContainText("Polish the settings page");
  await expect(workspaces).not.toContainText("Investigate the flaky test");
  await expect(workspaces).not.toContainText("Bump the SDK");
  await expect(workspaces).not.toContainText("Read the CI logs");

  // The summary card, open by default on a wide window, lists every descendant
  // grouped by where it stands.
  const threads = page.getByRole("region", { name: "Threads", exact: true });
  await expect(threads).toContainText("1 shipped · 3 open");
  await expect(threads.getByRole("region", { name: "Ready to ship" })).toContainText(
    "Fix the docs",
  );
  await expect(threads.getByRole("region", { name: "Working" })).toContainText(
    "Investigate the flaky test",
  );
  await expect(threads.getByRole("region", { name: "Idle" })).toContainText("Read the CI logs");
  await expect(threads.getByRole("region", { name: "Shipped" })).toContainText("Merged #42");

  if (shots) await page.screenshot({ path: `${shots}/desktop-parent.png` });

  // The turn that spawned threads shows live cards for them.
  const cards = page.locator(".thread-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Working");
  await expect(cards.last()).toContainText("Shipped · Merged #42");

  // Opening a child keeps its root lit in the sidebar, with the parent as a breadcrumb.
  await cards.first().click();
  await expect(
    page.getByRole("heading", { name: "Investigate the flaky test", exact: true }),
  ).toBeVisible();
  await expect(workspaces.locator(".workspace-row.active")).toHaveText(/Coordinate the release/);
  await expect(workspaces.locator(".workspace-row")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "Coordinate the release", exact: true }),
  ).toBeVisible();

  if (shots) await page.screenshot({ path: `${shots}/desktop-child.png` });

  // Keep in sidebar gives the child a row of its own, persisted on the server.
  await page.getByRole("button", { name: "Keep in sidebar", exact: true }).click();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(4);
  await expect(workspaces.locator(".workspace-row.active")).toHaveText(
    /Investigate the flaky test/,
  );
  expect(updates).toEqual([{ id: "flaky", kept: true }]);
  await page.reload();
  // The kept row survives a reload and opens the child directly.
  await workspaces
    .locator(".workspace-row")
    .filter({ hasText: "Investigate the flaky test" })
    .click();
  await expect(workspaces.locator(".workspace-row.active")).toHaveText(
    /Investigate the flaky test/,
  );
  await page.getByRole("button", { name: "Remove from sidebar", exact: true }).click();
  await expect(workspaces.locator(".workspace-row")).toHaveCount(3);
  expect(updates).toEqual([
    { id: "flaky", kept: true },
    { id: "flaky", kept: false },
  ]);

  // The breadcrumb returns to the parent.
  await page.getByRole("button", { name: "Coordinate the release", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Coordinate the release", exact: true }),
  ).toBeVisible();
});

test("hides spawned sessions from the mobile sidebar too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Coordinate the release", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(workspaces).toContainText("Coordinate the release");

  if (shots) await page.screenshot({ path: `${shots}/mobile-sidebar.png` });

  await expect(workspaces.locator(".workspace-row")).toHaveCount(3);
  await expect(workspaces).not.toContainText("Investigate the flaky test");
});
