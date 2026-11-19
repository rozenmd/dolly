import { expect, test, type Page } from "./browser";

const signedIn = {
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
};

const pullRequest = {
  repository: "octocat/project",
  number: 1379,
  url: "https://github.com/octocat/project/pull/1379",
  state: "open",
  title: "Prepare teams and public IDs",
  additions: 1349,
  deletions: 11,
  changedFiles: 24,
};

const sessions = [
  { id: "plain", title: "Plain task", model: "gpt-6-sol", repository: "" },
  {
    id: "pulled",
    title: "Pulled task",
    model: "gpt-6-sol",
    thinkingLevel: "high",
    repository: "octocat/project",
    pullRequest,
  },
].map((session, index) => ({ ...session, updatedAt: index + 1, archived: false }));

async function workspace(page: Page, width: number, height = 800) {
  await page.setViewportSize({ width, height });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/sessions") return route.fulfill({ json: sessions });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/*/events", (socket) =>
    socket.send(JSON.stringify({ entries: [], docs: {} })),
  );
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Pulled task", exact: true })).toBeVisible();
}

const summary = (page: Page) => page.getByRole("complementary", { name: "Session summary" });
const toggle = (page: Page) => page.getByRole("button", { name: "Session summary" });

const layout = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector(".session-summary")?.getBoundingClientRect();
    const header = document.querySelector(".workspace-header")!.getBoundingClientRect();
    const composer = document.querySelector(".composer-shell")!.getBoundingClientRect();

    return {
      headerBottom: header.bottom,
      top: card?.top ?? 0,
      right: card?.right ?? 0,
      left: card?.left ?? 0,
      composerRight: composer.right,
    };
  });

test("summary card stands at the top right beside the conversation and follows every session", async ({
  page,
}) => {
  await workspace(page, 1440, 900);

  // Open for anyone who has not closed it, with the pull request band first.
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(summary(page)).toContainText("Pull request open");
  await expect(summary(page)).toContainText("#1379 Prepare teams and public IDs");
  await expect(summary(page)).toContainText("+1349");
  await expect(summary(page)).toContainText("−11");
  await expect(summary(page)).toContainText("Idle");
  await expect(summary(page)).toContainText("High");
  await expect(
    page.getByRole("link", { name: "Open pull request #1379 on GitHub" }),
  ).toHaveAttribute("href", pullRequest.url);
  await expect(page.locator(".summary-row").filter({ hasText: "Changes" })).toHaveAttribute(
    "href",
    `${pullRequest.url}/files`,
  );

  // A floating card under the header at the window's right edge; the composer
  // steps aside rather than running under it.
  const open = await layout(page);
  expect(open.top).toBe(open.headerBottom + 12);
  expect(open.right).toBe(1440 - 12);
  expect(open.composerRight).toBeLessThanOrEqual(open.left);
  await page.screenshot({ path: test.info().outputPath("desktop-open.png") });

  // One preference for every session: another session shows it too, without a PR band.
  await page.locator(".workspace-row").filter({ hasText: "Plain task" }).click();
  await expect(page.getByRole("heading", { name: "Plain task", exact: true })).toBeVisible();
  await expect(summary(page)).toContainText("Idle");
  await expect(summary(page)).not.toContainText("Pull request");

  // Closing it is remembered across reloads, and the conversation takes the room back.
  await toggle(page).click();
  await expect(summary(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  expect((await layout(page)).composerRight).toBeGreaterThan(open.composerRight);
  // The reload reopens the session in the URL.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Plain task", exact: true })).toBeVisible();
  await expect(summary(page)).toHaveCount(0);

  // A standing card ignores clicks elsewhere and Escape.
  await toggle(page).click();
  await expect(summary(page)).toBeVisible();
  await page.getByRole("heading", { name: "Plain task", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(summary(page)).toBeVisible();
});

for (const width of [900, 390]) {
  test(`summary card is an overlay that leaves on an outside click at ${width}px`, async ({
    page,
  }) => {
    await workspace(page, width, 844);
    // Too narrow to stand beside the transcript, so it waits to be asked for.
    await expect(summary(page)).toHaveCount(0);
    await toggle(page).click();
    await expect(summary(page)).toContainText("Pull request open");

    const box = await page.evaluate(() => {
      const rect = document.querySelector(".session-summary")!.getBoundingClientRect();

      return {
        inside: rect.left >= 0 && rect.right <= window.innerWidth,
        overflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });

    expect(box).toEqual({ inside: true, overflow: true });
    await page.screenshot({ path: test.info().outputPath(`overlay-${width}.png`) });

    await page.keyboard.press("Escape");
    await expect(summary(page)).toHaveCount(0);
    await toggle(page).click();
    await expect(summary(page)).toBeVisible();
    await page.locator(".composer textarea").click();
    await expect(summary(page)).toHaveCount(0);

    // The overlay never became the stored preference: a wide window still shows the card.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(summary(page)).toBeVisible();
  });
}
