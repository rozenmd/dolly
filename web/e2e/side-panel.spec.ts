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

const sessions = [
  { id: "first", title: "First task", model: "gpt-6-sol", repository: "octocat/project" },
  { id: "second", title: "Second task", model: "gpt-6-sol", repository: "" },
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
  await expect(page.getByRole("heading", { name: "Second task", exact: true })).toBeVisible();
}

const details = (page: Page) => page.getByRole("complementary", { name: "Session details" });
const toggle = (page: Page) => page.getByRole("button", { name: "Toggle side panel" });

const panelWidth = (page: Page) =>
  page.evaluate(() => document.querySelector(".side-panel")?.getBoundingClientRect().width ?? 0);

test("side panel is a full-height column whose open state belongs to each session", async ({
  page,
}) => {
  await workspace(page, 1440, 900);
  // A session nobody has opened the panel in starts with it closed.
  await expect(details(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await toggle(page).click();
  await expect(details(page)).toContainText("Idle");

  // The column spans the window's height beside the header, and the toggle moves
  // into the panel's own top row, at the same place in the top-right corner.
  const layout = await page.evaluate(() => {
    const panel = document.querySelector(".side-panel")!.getBoundingClientRect();
    const header = document.querySelector(".workspace-header")!.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('[aria-label="Toggle side panel"]')];

    return {
      top: panel.top,
      bottom: panel.bottom,
      headerRight: header.right,
      panelLeft: panel.left,
      toggles: buttons.length,
      inPanel: buttons.every((button) => button.closest(".side-panel") !== null),
    };
  });

  expect(layout).toEqual({
    top: 0,
    bottom: 900,
    headerRight: layout.panelLeft,
    panelLeft: layout.panelLeft,
    toggles: 1,
    inPanel: true,
  });
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");

  // Another session keeps its own (closed) panel; coming back restores the open one.
  await page.locator(".workspace-row").filter({ hasText: "First task" }).click();
  await expect(page.getByRole("heading", { name: "First task", exact: true })).toBeVisible();
  await expect(details(page)).toHaveCount(0);
  await page.locator(".workspace-row").filter({ hasText: "Second task" }).click();
  await expect(details(page)).toBeVisible();

  // The choice survives a reload, and closing it from the panel puts the toggle back.
  await page.reload({ waitUntil: "networkidle" });
  await expect(details(page)).toBeVisible();
  await toggle(page).click();
  await expect(details(page)).toHaveCount(0);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Second task", exact: true })).toBeVisible();
  await expect(details(page)).toHaveCount(0);
});

test("side panel resizes from its left edge within bounds and remembers the width", async ({
  page,
}) => {
  await workspace(page, 1440, 900);
  await toggle(page).click();
  await expect(details(page)).toBeVisible();
  // Default: a third of the window's content area, never under 320px.
  const initial = await panelWidth(page);
  expect(initial).toBeGreaterThanOrEqual(320);

  const handle = page.getByRole("separator", { name: "Resize side panel" });
  await handle.focus();

  for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowLeft");
  await expect.poll(() => panelWidth(page)).toBe(Math.round(initial) + 96);

  // A drag follows the pointer: the width is its distance from the right edge.
  await page.evaluate(() => {
    const target = document.querySelector(".side-panel-resize")!;
    const init = { bubbles: true, button: 0, pointerId: 1, isPrimary: true };
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: 1000 }));
    window.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: 1440 - 500 }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: 1440 - 500 }));
  });
  await expect.poll(() => panelWidth(page)).toBe(500);

  // The conversation keeps 620px: the panel cannot be dragged past that.
  await page.evaluate(() => {
    const target = document.querySelector(".side-panel-resize")!;
    const init = { bubbles: true, button: 0, pointerId: 1, isPrimary: true };
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: 900 }));
    window.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: 0 }));
    window.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: 0 }));
  });
  await expect.poll(() => panelWidth(page)).toBe(1440 - 620);
  await page.screenshot({ path: test.info().outputPath("desktop-open.png") });

  await page.reload({ waitUntil: "networkidle" });
  await expect(details(page)).toBeVisible();
  await expect.poll(() => panelWidth(page)).toBe(1440 - 620);
});

for (const width of [900, 390]) {
  test(`side panel is an overlay with a scrim at ${width}px`, async ({ page }) => {
    await workspace(page, width, 844);
    await toggle(page).click();
    await expect(details(page)).toBeVisible();

    const box = await page.evaluate(() => {
      const panel = document.querySelector(".side-panel")!;
      const rect = panel.getBoundingClientRect();

      return {
        position: getComputedStyle(panel).position,
        right: rect.right,
        width: Math.round(rect.width),
        overflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });

    expect(box).toEqual({
      position: "fixed",
      right: width,
      width: Math.round(Math.min(480, width * 0.94)),
      overflow: true,
    });
    await expect(page.getByRole("separator", { name: "Resize side panel" })).not.toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`overlay-${width}.png`) });

    // Tapping the scrim beside the panel closes it.
    const tapped = await page.evaluate(() => {
      const target = document.elementFromPoint(8, 400);

      if (target instanceof HTMLElement) target.click();

      return target?.className;
    });

    expect(tapped).toBe("side-panel-scrim");
    await expect(details(page)).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
  });
}
