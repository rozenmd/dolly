import * as Schema from "effect/Schema";
import { expect, test } from "./browser";
import type { SavedSession } from "../src/lib/api";

const Rename = Schema.Struct({ name: Schema.String });

const now = Date.now();

const chief = {
  id: "chief",
  title: "Dolly",
  chief: true,
  model: "gpt-6-sol",
  repository: "",
  // Older than every workspace: it still comes first.
  updatedAt: now - 30 * 86_400_000,
  archived: false,
};

let chiefName = "Dolly";

// Sessions a test adds to the list, such as the chief's delegated ones.
let extra: SavedSession[] = [];
const shots = process.env.SCREENSHOT_DIR;
const updates: { id: string; body: unknown }[] = [];
const renames: unknown[] = [];

test.beforeEach(async ({ page }) => {
  chiefName = "Dolly";
  extra = [];
  updates.length = 0;
  renames.length = 0;
  await page.setViewportSize({ width: 1280, height: 800 });

  const sessions = () => [
    { ...chief, title: chiefName },
    {
      id: "pinned",
      title: "Pinned work",
      model: "gpt-6-sol",
      repository: "octocat/project",
      updatedAt: now - 3_600_000,
      archived: false,
      pinnedAt: now - 7_200_000,
    },
    {
      id: "recent",
      title: "Recent work",
      model: "gpt-6-sol",
      repository: "octocat/project",
      updatedAt: now,
      archived: false,
    },
    ...extra,
  ];

  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/sessions") return route.fulfill({ json: sessions() });

    if (path === "/api/settings/chief") {
      if (request.method() === "PUT") {
        const body = Schema.decodeUnknownSync(Rename)(request.postDataJSON());
        renames.push(body);
        chiefName = body.name.trim();
      }

      return route.fulfill({ json: { name: chiefName } });
    }

    if (path.startsWith("/api/sessions/") && request.method() === "PUT") {
      updates.push({ id: path.split("/").at(-1) ?? "", body: request.postDataJSON() });

      return route.fulfill({ json: request.postDataJSON() });
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
  await page.routeWebSocket("**/api/sessions/*/events", (socket) =>
    socket.send(JSON.stringify({ entries: [], docs: {} })),
  );
});

test("shows the chief of staff first, above pinned workspaces, with no archive control", async ({
  page,
}) => {
  await page.goto("/");

  const chiefList = page.getByRole("navigation", { name: "Chief of staff", exact: true });
  await expect(chiefList.locator(".workspace-row")).toHaveCount(1);
  await expect(chiefList).toContainText("Dolly");

  const pinned = page.getByRole("navigation", { name: "Pinned workspaces", exact: true });
  await expect(pinned).toContainText("Pinned work");

  // The chief is not also listed as a workspace.
  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(workspaces.locator(".workspace-row")).toHaveCount(1);
  await expect(workspaces).toContainText("Recent work");
  await expect(page.getByText("Archived workspaces (0)", { exact: true })).toBeVisible();

  const order = await page.evaluate(() => {
    const chief = document.querySelector('nav[aria-label="Chief of staff"]');
    const pinned = document.querySelector('nav[aria-label="Pinned workspaces"]');

    return Boolean(
      chief && pinned && chief.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  expect(order).toBe(true);

  // No archive or pin control for it, in the sidebar or the header once it is open.
  await expect(page.getByRole("button", { name: "Archive workspace: Dolly" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pin workspace: Dolly" })).toHaveCount(0);
  await chiefList.locator(".workspace-row").click();
  await expect(page.getByRole("heading", { name: "Dolly", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive session", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pin workspace", exact: true })).toHaveCount(0);
  expect(updates).toEqual([]);

  // Other workspaces keep theirs.
  await workspaces.locator(".workspace-row").click();
  await expect(page.getByRole("button", { name: "Archive session", exact: true })).toBeVisible();
});

test("renames the chief of staff from Settings", async ({ page }) => {
  await page.goto("/settings/account");

  const name = page.getByLabel("Chief of staff");
  await expect(name).toHaveValue("Dolly");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();

  await name.fill("  Ada  ");
  await save.click();
  await expect(name).toHaveValue("Ada");
  expect(renames).toEqual([{ name: "Ada" }]);
  await expect(save).toBeDisabled();

  // Forty characters are allowed however many UTF-16 units they take; forty-one are not.
  await name.fill("🦊".repeat(41));
  await expect(save).toBeDisabled();
  await name.fill("🦊".repeat(40));
  await save.click();
  await expect(name).toHaveValue("🦊".repeat(40));
  expect(renames).toEqual([{ name: "Ada" }, { name: "🦊".repeat(40) }]);

  await page.getByRole("link", { name: "Back to app" }).click();
  const chiefList = page.getByRole("navigation", { name: "Chief of staff", exact: true });
  await expect(chiefList).toContainText("🦊".repeat(40));
});

test("lists each session the chief spawns as a workspace of its repository, marked as the chief's", async ({
  page,
}) => {
  extra = [
    {
      id: "delegated",
      parentId: "chief",
      // As an older server described it: in the chief's workspace.
      workspaceId: "chief",
      title: "Fix the sidebar grouping",
      model: "gpt-6-sol",
      repository: "octocat/dolly",
      updatedAt: now - 60_000,
      archived: false,
      running: true,
    },
    {
      id: "delegated-helper",
      parentId: "delegated",
      title: "Read the CI logs",
      model: "gpt-6-sol",
      repository: "octocat/dolly",
      updatedAt: now - 30_000,
      archived: false,
    },
    {
      id: "nested",
      parentId: "recent",
      title: "Child of recent work",
      model: "gpt-6-sol",
      repository: "octocat/project",
      updatedAt: now - 1_000,
      archived: false,
    },
  ];

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const workspaces = page.getByRole("navigation", { name: "Workspaces", exact: true });
  await expect(workspaces).toContainText("Recent work");

  if (shots) await page.screenshot({ path: `${shots}/chief-spawned-desktop.png` });

  await expect(workspaces.locator(".workspace-row")).toHaveCount(2);

  const delegated = workspaces
    .locator(".workspace-row")
    .filter({ hasText: "Fix the sidebar grouping" });

  // Badged with its own repository, octocat/dolly, not the chief's (none).
  await expect(delegated.locator(".repo-badge")).toHaveText("D");
  await expect(delegated.getByRole("img", { name: "Started by Dolly" })).toBeVisible();
  await expect(delegated.getByLabel("Agent working")).toBeVisible();

  // Other sessions' children, and the delegated session's own, stay with their parent.
  await expect(workspaces).not.toContainText("Child of recent work");
  await expect(workspaces).not.toContainText("Read the CI logs");
  await expect(workspaces.locator(".workspace-from")).toHaveCount(1);

  // It opens as its own workspace, with a breadcrumb back to the chief and no keep-as-tab toggle.
  await delegated.click();
  await expect(page.getByRole("heading", { name: "Fix the sidebar grouping" })).toBeVisible();
  await expect(page).toHaveURL(/\/workspace\/delegated\/session\/delegated$/);
  await expect(page.getByRole("button", { name: "Dolly", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep as workspace tab" })).toHaveCount(0);

  // The phone sidebar lists it too.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workspace/recent/session/recent");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(workspaces).toContainText("Recent work");

  if (shots) await page.screenshot({ path: `${shots}/chief-spawned-phone.png` });

  await expect(workspaces).toContainText("Fix the sidebar grouping");
});
