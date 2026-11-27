import { expect, test, type Page, type WebSocketRoute } from "./browser";

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

const start = Date.now() - 60 * 60_000;

/** Enough lines that the 40th tool result scrolls inside its own box once opened. */
const LONG_OUTPUT = Array.from({ length: 60 }, (_, line) => `line ${line}`).join("\n");

/** A running turn: its prompt, then `rounds` narrated tool calls with their results. */
function snapshot(rounds: number) {
  const entries: object[] = [
    {
      id: 1,
      kind: "pi.user",
      model: [{ role: "user", content: "Keep going", timestamp: start }],
    },
  ];

  for (let round = 0; round < rounds; round++) {
    const at = start + (round + 1) * 1000;

    entries.push(
      {
        id: entries.length + 1,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [
              { type: "text", text: `Narration ${round}` },
              { type: "toolCall", id: `call_${round}`, name: "shell", arguments: {} },
            ],
            timestamp: at,
            stopReason: "toolUse",
          },
        ],
      },
      {
        id: entries.length + 2,
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: `call_${round}`,
            toolName: "shell",
            content: round === 39 ? LONG_OUTPUT : "ok",
            timestamp: at + 500,
          },
        ],
      },
    );
  }

  return JSON.stringify({ entries, docs: { "pi.live": { run: {} } } });
}

async function open(page: Page, rounds: number) {
  let socket: WebSocketRoute | undefined;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/sessions")
      return route.fulfill({
        json: [
          { id: "live", model: "gpt-6-sol", title: "Live task", repository: "", updatedAt: 1 },
        ],
      });

    if (url.pathname === "/api/auth") return route.fulfill({ json: signedIn });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/live/events", (route) => {
    socket = route;
    route.send(snapshot(rounds));
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText(`Narration ${rounds - 1}`, { exact: true })).toBeVisible();
  await expect.poll(async () => (await distance(page)) <= 3).toBe(true);

  return async (more: number) => {
    socket!.send(snapshot(more));
    await expect(page.getByText(`Narration ${more - 1}`, { exact: true })).toHaveCount(1);
  };
}

/** How far the reader is above the bottom of the conversation. */
const distance = (page: Page) =>
  page.evaluate(() => {
    const scroll = document.querySelector(".conversation-scroll")!;

    return Math.round(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop);
  });

const scrollTop = (page: Page, selector = ".conversation-scroll") =>
  page.evaluate((selector) => Math.round(document.querySelector(selector)!.scrollTop), selector);

/** Turn the wheel over the conversation and wait for the scroll to come to rest. */
async function wheel(page: Page, deltaY: number, over = ".conversation-scroll") {
  const { x, y } = await page.evaluate((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();

    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, over);

  const before = await scrollTop(page, over);

  await page.mouse.wheel(x, y, deltaY);
  await expect.poll(async () => (await scrollTop(page, over)) !== before).toBe(true);

  let last = -1;

  await expect
    .poll(async () => {
      const now = await scrollTop(page, over);
      const settled = now === last;
      last = now;

      return settled;
    })
    .toBe(true);
}

/** Past the window in which a scroll still counts as the reader's own. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 1200));

test("reading just above the bottom is not pulled down by new output", async ({ page }) => {
  const stream = await open(page, 40);

  await wheel(page, -40);
  const held = await scrollTop(page);
  expect(await distance(page)).toBeGreaterThan(3);
  await pause();

  await stream(41);
  await stream(42);
  expect(await scrollTop(page)).toBe(held);
});

test("content shrinking under the reader does not start following again", async ({ page }) => {
  const stream = await open(page, 40);

  await wheel(page, -150);

  // Output below the reader gets shorter while their wheel turn is still fresh: the browser moves
  // them up to the new bottom on its own.
  await stream(36);
  await expect.poll(async () => (await distance(page)) <= 3).toBe(true);
  const held = await scrollTop(page);

  await stream(40);
  expect(await scrollTop(page)).toBe(held);
  expect(await distance(page)).toBeGreaterThan(3);
});

test("scrolling back to the bottom follows new output again", async ({ page }) => {
  const stream = await open(page, 40);

  await wheel(page, -300);
  await pause();
  await wheel(page, 2000);
  await pause();

  await stream(41);
  await expect.poll(async () => (await distance(page)) <= 3).toBe(true);
});

test("scrolling inside a tool result's output keeps following the conversation", async ({
  page,
}) => {
  const stream = await open(page, 40);

  // Open the newest tool result, with its own output scrolled to the end, at the bottom of the page.
  await page.evaluate(() => {
    const steps = document.querySelectorAll<HTMLDetailsElement>("details.step");
    const step = steps[steps.length - 1]!;

    for (let node: Element | null = step; node; node = node.parentElement)
      if (node instanceof HTMLDetailsElement) node.open = true;
  });
  await expect.poll(async () => (await page.locator(".step-output").count()) > 0).toBe(true);
  await page.evaluate(() => {
    const outputs = document.querySelectorAll(".step-output");
    const output = outputs[outputs.length - 1]!;
    const scroll = document.querySelector(".conversation-scroll")!;

    output.setAttribute("data-reading", "");
    output.scrollTop = output.scrollHeight;
    scroll.scrollTop = scroll.scrollHeight;
  });
  await expect.poll(async () => (await distance(page)) <= 3).toBe(true);

  // Reading back through the output moves only the output.
  await wheel(page, -40, "[data-reading]");
  expect(await distance(page)).toBeLessThanOrEqual(3);
  await pause();

  await stream(41);
  await expect.poll(async () => (await distance(page)) <= 3).toBe(true);
});
