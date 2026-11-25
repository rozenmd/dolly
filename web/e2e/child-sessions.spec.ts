import { expect, test } from "./browser";
import { workerReportMessage } from "../../src/child-report-message";
import { sessionWaitMessage } from "../../src/ci-wait-message";

// Spawned sessions join their root's workspace and are reached from their parent.
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
  arguments: { prompt: content },
});

const spawnResult = (id: string) => ({
  role: "toolResult",
  toolCallId: `call-${id}`,
  toolName: "spawn_task",
  content: [
    {
      type: "text",
      text: `Spawned task \`${id}\` — /session/${id}\nMetadata: model=gpt-6-sol · createdAt=2026-01-01T00:00:00.000Z. It runs in the background.`,
    },
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
    {
      id: 3,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: workerReportMessage({
            child: "sdk",
            message: "Bumped the SDK to 4.2. The tests pass; I'm confident.",
            evidence:
              "— evidence for `sdk` (computed by the server, not written by the worker) —\nstate: running · branch dolly/session-sdk of octocat/project · 3 turn(s)\ngit: commit, push",
          }),
          timestamp: now - 30_000,
        },
      ],
    },
    {
      id: 5,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: sessionWaitMessage("7", {
            outcome: "finished",
            headline: 'Session `sdk` ("Bump the SDK") is idle (turn finished).',
            detail: "Last assistant message (tail):\nBumped the SDK to 4.2.",
            prompt: "Read what the session reported and decide the next step.",
          }),
          timestamp: now - 29_500,
        },
      ],
    },
    {
      id: 4,
      kind: "pi.assistant",
      model: [{ role: "assistant", content: "The SDK bump is merged.", timestamp: now - 29_000 }],
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

  // One row per workspace; spawned sessions join their root's.
  await expect(workspaces.locator(".workspace-row")).toHaveCount(2);
  await expect(workspaces).toContainText("Coordinate the release");
  await expect(workspaces).not.toContainText("Fix the docs");
  await expect(workspaces).toContainText("Polish the settings page");
  await expect(workspaces).not.toContainText("Investigate the flaky test");
  await expect(workspaces).not.toContainText("Bump the SDK");
  await expect(workspaces).not.toContainText("Read the CI logs");

  // The workspace's tabs are its sessions plus the spawned one the owner kept.
  const tabs = page.getByRole("navigation", { name: "Workspace sessions", exact: true });
  await expect(tabs.locator(".workspace-tab")).toHaveCount(2);
  await expect(tabs.locator(".workspace-tab").first()).toHaveText("Coordinate the release");
  await expect(tabs.locator(".workspace-tab").last()).toHaveText("Fix the docs");

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
  await expect(workspaces.locator(".workspace-row")).toHaveCount(2);
  await expect(tabs.locator(".workspace-tab.active")).toHaveText("Coordinate the release");
  await expect(
    page
      .locator(".breadcrumb")
      .getByRole("button", { name: "Coordinate the release", exact: true }),
  ).toBeVisible();

  if (shots) await page.screenshot({ path: `${shots}/desktop-child.png` });

  // Keeping the child makes it a tab of its own, persisted on the server.
  await page.getByRole("button", { name: "Keep as workspace tab", exact: true }).click();
  await expect(tabs.locator(".workspace-tab")).toHaveCount(3);
  await expect(tabs.locator(".workspace-tab.active")).toHaveText(/Investigate the flaky test/);
  await expect(workspaces.locator(".workspace-row")).toHaveCount(2);
  expect(updates).toEqual([{ id: "flaky", kept: true }]);
  await page.reload();
  // The kept tab survives a reload and opens the child directly.
  await tabs.locator(".workspace-tab").filter({ hasText: "Investigate the flaky test" }).click();
  await expect(tabs.locator(".workspace-tab.active")).toHaveText(/Investigate the flaky test/);
  await page.getByRole("button", { name: "Remove workspace tab", exact: true }).click();
  await expect(tabs.locator(".workspace-tab")).toHaveCount(2);
  expect(updates).toEqual([
    { id: "flaky", kept: true },
    { id: "flaky", kept: false },
  ]);

  // The breadcrumb returns to the parent.
  await page
    .locator(".breadcrumb")
    .getByRole("button", { name: "Coordinate the release", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Coordinate the release", exact: true }),
  ).toBeVisible();
});

test("shows a child's report as a card that opens the child", async ({ page }) => {
  await expect(page.getByText("The SDK bump is merged.")).toBeVisible();

  // The report is a notice, not a message the owner typed.
  const report = page.getByRole("group", { name: "child session report", exact: true });
  await expect(report).toContainText("Report: Bump the SDK");
  await expect(page.getByText("Bumped the SDK to 4.2. The tests pass")).not.toBeVisible();

  await report.locator("summary").click();
  await expect(report).toContainText("Bumped the SDK to 4.2. The tests pass; I'm confident.");
  await expect(report).toContainText("Computed by the server from its transcript");
  await expect(report).toContainText(
    "state: running · branch dolly/session-sdk of octocat/project · 3 turn(s)",
  );
  await expect(report).not.toContainText("— evidence for");

  // The session_turn wait that woke the parent is a notice too.
  const wake = page.getByRole("group", { name: "Session wait result", exact: true });
  await expect(wake).toContainText('Session `sdk` ("Bump the SDK") is idle (turn finished).');
  await wake.locator("summary").click();
  await expect(wake).toContainText("Bumped the SDK to 4.2.");

  if (shots) await page.screenshot({ path: `${shots}/desktop-report.png` });

  await report.getByRole("button", { name: "Open Bump the SDK", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bump the SDK", exact: true })).toBeVisible();
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

  await expect(workspaces.locator(".workspace-row")).toHaveCount(2);
  await expect(workspaces).not.toContainText("Investigate the flaky test");
});

test("turns coordinator mode on for the open session from the model menu", async ({ page }) => {
  const settings: unknown[] = [];

  await page.route("**/api/sessions/root/settings", (route) => {
    const body = route.request().postDataJSON();
    settings.push(body);
    sessions = sessions.map((session) =>
      session.id === "root" ? { ...session, ...body } : session,
    );

    return route.fulfill({ json: body });
  });
  await expect(page.getByText("The SDK bump is merged.")).toBeVisible();

  await page.getByRole("button", { name: /GPT-6 Sol/ }).click();
  const toggle = page.getByRole("menuitemcheckbox", { name: /Coordinator/ });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toContainText("Delegate work to child sessions");

  if (shots) await page.screenshot({ path: `${shots}/desktop-coordinator.png` });

  await toggle.click();
  expect(settings).toEqual([{ coordinator: true }]);
  await page.getByRole("button", { name: /GPT-6 Sol/ }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Coordinator/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
