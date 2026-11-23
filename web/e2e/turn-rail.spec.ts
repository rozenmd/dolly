import { expect, test, type Page } from "./browser";
import type { Message } from "../../src/transcript";

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

/** `turns` answered prompts, each answer `paragraphs` long; the first turn opens a pull request. */
function transcript(turns: number, paragraphs: number) {
  const start = Date.now() - 60 * 60_000;
  const entries: { id: number; kind: string; model: (typeof Message.Type)[] }[] = [];

  const push = (kind: string, model: typeof Message.Type) =>
    entries.push({ id: entries.length + 1, kind, model: [model] });

  for (let turn = 0; turn < turns; turn++) {
    const at = start + turn * 60_000;
    push("pi.user", { role: "user", content: `Prompt ${turn}`, timestamp: at });

    if (turn === 0) {
      push("pi.assistant", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_pr", name: "github", arguments: {} }],
        timestamp: at + 1000,
        stopReason: "toolUse",
      });
      push("pi.tool", {
        role: "toolResult",
        toolCallId: "call_pr",
        toolName: "github",
        content: JSON.stringify({
          ok: true,
          result: {
            kind: "pull_request",
            number: 1439,
            url: "https://github.com/octocat/project/pull/1439",
          },
        }),
        timestamp: at + 2000,
      });
    }

    const body = Array.from({ length: paragraphs }, (_, line) => `Answer ${turn}, line ${line}.`);
    push("pi.assistant", {
      role: "assistant",
      content: [{ type: "text", text: body.join("\n\n") }],
      timestamp: at + 3000,
      stopReason: "stop",
    });
  }

  return entries;
}

/**
 * Opens a session of `turns` prompts. With `window`, the live view holds only its newest `window` entries,
 * as a long session's does: earlier ones come from the history and prompt-index routes, which record what
 * they were asked for.
 */
async function open(
  page: Page,
  {
    turns,
    paragraphs,
    width = 1280,
    window,
  }: { turns: number; paragraphs: number; width?: number; window?: number },
) {
  const entries = transcript(turns, paragraphs);
  const shown = window === undefined ? entries : entries.slice(-window);
  const before = window === undefined ? undefined : shown[0]!.id - 1;
  const history: number[] = [];
  const prompts: number[] = [];
  const asked = { history, prompts };

  await page.setViewportSize({ width, height: 800 });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const through = Number(url.searchParams.get("through"));

    if (url.pathname === "/api/sessions")
      return route.fulfill({
        json: [{ id: "rail", model: "gpt-6-sol", title: "Rail", repository: "", updatedAt: 1 }],
      });

    if (url.pathname === "/api/auth") return route.fulfill({ json: signedIn });

    // Small pages, so reaching the first turn takes several.
    if (url.pathname === "/api/sessions/rail/history") {
      asked.history.push(through);
      const older = entries.filter((entry) => entry.id <= through);
      const next = older.at(-5);

      return route.fulfill({
        json: next ? { entries: older.slice(-4), before: next.id } : { entries: older.slice(-4) },
      });
    }

    if (url.pathname === "/api/sessions/rail/prompts") {
      asked.prompts.push(through);

      const prompts = entries.flatMap((entry) => {
        const message = entry.model[0]!;

        if (entry.id > through || message.role !== "user") return [];

        const turn = Number(String(message.content).replace("Prompt ", ""));

        return [
          {
            id: `${entry.id}-0`,
            text: String(message.content),
            at: message.timestamp,
            reply: `Answer ${turn}, line 0.`,
          },
        ];
      });

      return route.fulfill({ json: { prompts } });
    }

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/rail/events", (socket) =>
    // JSON drops an undefined `before`: a window holding the whole session.
    socket.send(JSON.stringify({ entries: shown, before, docs: {} })),
  );
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText(`Prompt ${turns - 1}`, { exact: true })).toBeVisible();

  return asked;
}

const rail = (page: Page) => page.getByRole("button", { name: "Jump to a message" });

/** Each tick's horizontal scale and opacity, top to bottom. */
const ticks = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".turn-tick")].map((tick) => ({
      scale: new DOMMatrix(getComputedStyle(tick).transform).a,
      ink: Number(getComputedStyle(tick).opacity),
    })),
  );

/** Where a tick's centre is on screen. */
const tickPoint = (page: Page, index: number) =>
  page.evaluate((at) => {
    const box = document.querySelectorAll(".turn-tick")[at]!.getBoundingClientRect();
    const strip = document.querySelector(".turn-rail")!.getBoundingClientRect();

    return { x: strip.left + strip.width / 2, y: box.top + box.height / 2 };
  }, index);

/** How far below the conversation's top edge a prompt's turn starts. */
const turnOffset = (page: Page, prompt: string) =>
  page.evaluate((text) => {
    const scroll = document.querySelector(".conversation-scroll")!.getBoundingClientRect();

    const bubble = [...document.querySelectorAll(".prompt-bubble")].find(
      (node) => node.textContent === text,
    );

    // Not rendered yet (a turn still loading): far from anywhere it could be parked.
    if (!bubble) return 1e9;

    return Math.round(bubble.closest(".turn")!.getBoundingClientRect().top - scroll.top);
  }, prompt);

const preview = (page: Page) =>
  page.evaluate(() => document.querySelector(".turn-preview")?.textContent ?? "");

test("previews a turn under the pointer with a lens of ticks, and jumps to it on click", async ({
  page,
}) => {
  await open(page, { turns: 8, paragraphs: 12 });
  await expect(rail(page)).toBeVisible();
  await expect(page.locator(".turn-tick")).toHaveCount(8);

  // Pinned to the newest output, the last prompt is the one being read.
  await expect.poll(async () => (await ticks(page)).findIndex((tick) => tick.ink === 1)).toBe(7);

  // Point at the first tick: the card describes its turn, outcome included.
  const first = await tickPoint(page, 0);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...first });
  await expect.poll(async () => (await preview(page)).includes("Prompt 0")).toBe(true);
  const card = await preview(page);
  expect(card).toContain("Answer 0, line 0.");
  expect(card).toContain("Pull request #1439");

  // The lens: the tick under the pointer is longest, and growth falls off with distance.
  await expect.poll(async () => (await ticks(page))[0]?.scale).toBe(1);
  const lens = await ticks(page);
  expect(lens[1]!.scale).toBeLessThan(1);
  expect(lens[1]!.scale).toBeGreaterThan(lens[3]!.scale);

  // Scrubbing down the strip moves the card with the pointer.
  const third = await tickPoint(page, 2);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...third });
  await expect.poll(async () => (await preview(page)).includes("Prompt 2")).toBe(true);

  // Clicking parks that turn just below the conversation's top edge.
  for (const type of ["mousePressed", "mouseReleased"])
    await page.session.send("Input.dispatchMouseEvent", {
      type,
      ...third,
      button: "left",
      clickCount: 1,
    });
  await expect
    .poll(async () => Math.abs((await turnOffset(page, "Prompt 2")) - 20) <= 2)
    .toBe(true);

  // Leaving the rail closes the card, and the turn now being read is marked.
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 400 });
  await expect(page.locator(".turn-preview")).toHaveCount(0);
  await expect.poll(async () => (await ticks(page)).findIndex((tick) => tick.ink === 1)).toBe(2);
});

test("the rail answers the keyboard", async ({ page }) => {
  await open(page, { turns: 8, paragraphs: 12 });
  await rail(page).focus();
  await page.press("Home");
  await expect.poll(async () => (await preview(page)).includes("Prompt 0")).toBe(true);
  await page.press("ArrowDown");
  await expect.poll(async () => (await preview(page)).includes("Prompt 1")).toBe(true);
  await page.press("Enter");
  await expect
    .poll(async () => Math.abs((await turnOffset(page, "Prompt 1")) - 20) <= 2)
    .toBe(true);
  await page.press("Escape");
  await expect(page.locator(".turn-preview")).toHaveCount(0);
});

test("stays out of the way when there is nowhere to jump", async ({ page }) => {
  // Fits on one screen.
  await open(page, { turns: 2, paragraphs: 1 });
  await expect(rail(page)).toHaveCount(0);
});

test("is hidden at phone widths", async ({ page }) => {
  await open(page, { turns: 8, paragraphs: 12, width: 390 });
  await expect(rail(page)).not.toBeVisible();
});

test("reaches back to the first prompt of a session whose start isn't loaded yet", async ({
  page,
}) => {
  // 12 turns; the live window holds only the last three, and nothing earlier has loaded.
  const asked = await open(page, { turns: 12, paragraphs: 20, window: 6 });
  await expect(page.locator(".prompt-bubble").filter({ hasText: "Prompt 0" })).toHaveCount(0);

  // Every prompt is on the rail, indexed by the server up to the window.
  await expect(rail(page)).toBeVisible();
  await expect(page.locator(".turn-tick")).toHaveCount(12);
  expect(asked.prompts).toEqual([asked.prompts[0]]);
  expect(asked.history).toEqual([]);

  // The first tick previews the first turn from the index.
  const first = await tickPoint(page, 0);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...first });
  await expect.poll(async () => (await preview(page)).includes("Prompt 0")).toBe(true);
  expect(await preview(page)).toContain("Answer 0, line 0.");

  // Clicking loads every page back to it, then parks it just below the top edge.
  for (const type of ["mousePressed", "mouseReleased"])
    await page.session.send("Input.dispatchMouseEvent", {
      type,
      ...first,
      button: "left",
      clickCount: 1,
    });
  await expect
    .poll(async () => Math.abs((await turnOffset(page, "Prompt 0")) - 20) <= 2)
    .toBe(true);
  expect(asked.history.length).toBeGreaterThan(1);
  expect(asked.history).toEqual([...new Set(asked.history)]);

  // Still one tick per prompt, now from the loaded turns, and the first is the one being read.
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 400 });
  await expect(page.locator(".turn-tick")).toHaveCount(12);
  await expect.poll(async () => (await ticks(page)).findIndex((tick) => tick.ink === 1)).toBe(0);
  await expect(rail(page)).not.toHaveAttribute("aria-busy", "true");
});
