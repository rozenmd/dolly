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

// The working thread: its latest step is an edit, which its card shows.
const flakyTranscript = {
  entries: [
    {
      id: 1,
      kind: "pi.user",
      model: [{ role: "user", content: "Investigate the flaky test", timestamp: now - 59_000 }],
    },
    {
      id: 2,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: "Three of twenty runs time out waiting for the pay button.",
          timestamp: now - 50_000,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-1",
              name: "edit_file",
              arguments: { path: "web/src/checkout.tsx" },
            },
          ],
          timestamp: now - 40_000,
        },
      ],
    },
  ],
  docs: {
    "pi.live": { run: {}, tools: [{ callId: "edit-1", name: "edit_file", status: "running" }] },
  },
};

function transcriptFor(id = "") {
  switch (id) {
    case "root":
      return rootTranscript;
    case "flaky":
      return flakyTranscript;
    default:
      return { entries: [], docs: {} };
  }
}

let sessions: typeof fixture = [];
let updates: unknown[] = [];
let messages: { session: string; content?: string; requestId?: string }[] = [];

test.beforeEach(async ({ page }) => {
  sessions = structuredClone(fixture);
  updates = [];
  messages = [];
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions") return route.fulfill({ json: sessions });

    const message = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);

    if (message && route.request().method() === "POST") {
      messages.push({ session: message[1], ...route.request().postDataJSON() });

      // The first reply is accepted but its response is lost, as when a connection drops.
      if (messages.length === 1)
        return route.fulfill({ status: 503, json: { error: "Connection lost" } });

      return route.fulfill({ status: 202, json: { ok: true } });
    }

    const transcript = /^\/api\/sessions\/([^/]+)$/.exec(path);

    if (transcript && route.request().method() === "GET")
      return route.fulfill({ json: transcriptFor(transcript[1]) });

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

    socket.send(JSON.stringify(transcriptFor(id)));
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

  // Shipped work needs nothing more from anyone, so its group starts folded.
  const shipped = threads.getByRole("region", { name: "Shipped" });
  await expect(shipped).not.toContainText("Merged #42");
  await shipped.getByRole("button", { name: /Shipped/ }).click();
  await expect(shipped).toContainText("Merged #42");

  if (shots) await page.screenshot({ path: `${shots}/desktop-parent.png` });

  // The turn that spawned threads shows live cards for them, with a working one's current step.
  const cards = page.locator(".thread-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Working · Editing checkout.tsx");
  await expect(cards.last()).toContainText("Merged #42");

  // On a wide window a thread opens beside the conversation, in the summary card.
  await cards.first().click();
  const peek = page.getByRole("region", { name: "Thread: Investigate the flaky test" });
  await expect(peek).toContainText("Three of twenty runs time out waiting for the pay button.");
  await expect(
    page.getByRole("heading", { name: "Coordinate the release", exact: true }),
  ).toBeVisible();

  // A message typed there goes straight to the thread.
  await peek.getByRole("textbox", { name: "Message this thread" }).fill("Try a longer timeout");
  await peek.getByRole("button", { name: "Send to thread", exact: true }).click();
  await expect(peek.getByRole("alert")).toContainText("Connection lost");
  await expect(peek.getByRole("textbox", { name: "Message this thread" })).toHaveValue(
    "Try a longer timeout",
  );

  // Retrying the same text reuses its request ID, so the server can't run it twice, even after
  // the thread was closed and reopened.
  await peek.getByRole("button", { name: "Threads", exact: true }).click();
  await cards.first().click();
  await expect(peek.getByRole("textbox", { name: "Message this thread" })).toHaveValue(
    "Try a longer timeout",
  );
  await peek.getByRole("button", { name: "Send to thread", exact: true }).click();
  await expect(peek.getByRole("textbox", { name: "Message this thread" })).toHaveValue("");
  const [first, second] = messages;
  expect(
    messages.map(({ session, content, requestId = "" }) => ({
      session,
      content,
      uuid: /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(requestId),
    })),
  ).toEqual([
    { session: "flaky", content: "Try a longer timeout", uuid: true },
    { session: "flaky", content: "Try a longer timeout", uuid: true },
  ]);
  expect(second?.requestId).toBe(first?.requestId);

  if (shots) await page.screenshot({ path: `${shots}/desktop-thread.png` });

  // Back returns to the summary; the expand button opens the thread as its own page.
  await peek.getByRole("button", { name: "Threads", exact: true }).click();
  await expect(threads).toBeVisible();
  await cards.first().click();
  await peek.getByRole("button", { name: "Open as its own page", exact: true }).click();

  // Opening a child keeps its root lit in the sidebar, with the parent as a breadcrumb.
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
  await expect(wake).toContainText('Session sdk ("Bump the SDK") is idle (turn finished).');
  await wake.locator("summary").click();
  await expect(wake).toContainText("Bumped the SDK to 4.2.");

  if (shots) await page.screenshot({ path: `${shots}/desktop-report.png` });

  // The report opens its child beside the conversation, and from there as its own page.
  await report.getByRole("button", { name: "Open Bump the SDK", exact: true }).click();
  const peek = page.getByRole("region", { name: "Thread: Bump the SDK" });
  await expect(peek).toContainText("Merged #42");
  await peek.getByRole("button", { name: "Open as its own page", exact: true }).click();
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

test("opens a thread as its own page on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText("I started two threads and will report back.")).toBeVisible();

  await page.locator(".thread-card").first().click();
  await expect(
    page.getByRole("heading", { name: "Investigate the flaky test", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".thread-peek")).toHaveCount(0);
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
  // Like Auto-fallback, the switch flips in place and the menu stays open.
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(settings).toEqual([{ coordinator: true }]);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(settings).toEqual([{ coordinator: true }, { coordinator: false }]);
});
