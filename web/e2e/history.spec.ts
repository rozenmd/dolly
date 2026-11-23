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

const PROMPT = "Implement the spec end to end";

type Entry = { id: number; kind: string; model: object[] };

/** A long running turn: its prompt, then `rounds` narrated tool calls with their results. */
function transcript(rounds: number) {
  const start = Date.now() - 60 * 60_000;

  const entries: Entry[] = [
    {
      id: 1,
      kind: "pi.user",
      model: [{ role: "user", content: PROMPT, timestamp: start }],
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
            content: "ok",
            timestamp: at + 500,
          },
        ],
      },
    );
  }

  return entries;
}

/**
 * Opens a session whose live window holds only its newest `window` entries, answering
 * history requests from the full transcript, and records each `through` asked for.
 */
async function open(page: Page, { rounds, window }: { rounds: number; window: number }) {
  const entries = transcript(rounds);
  const shown = entries.slice(-window);
  const asked: number[] = [];

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/sessions")
      return route.fulfill({
        json: [
          { id: "long", model: "gpt-6-sol", title: "Long task", repository: "", updatedAt: 1 },
        ],
      });

    if (url.pathname === "/api/auth") return route.fulfill({ json: signedIn });

    if (url.pathname === "/api/sessions/long/history") {
      const through = Number(url.searchParams.get("through"));
      asked.push(through);
      const older = entries.filter((entry) => entry.id <= through);
      const page = older.slice(-20);
      const next = older.at(-21);

      return route.fulfill({
        json: next ? { entries: page, before: next.id } : { entries: page },
      });
    }

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/long/events", (socket) =>
    socket.send(
      JSON.stringify({
        entries: shown,
        before: shown[0]!.id - 1,
        docs: { "pi.live": { run: {} } },
      }),
    ),
  );
  await page.goto("/", { waitUntil: "networkidle" });

  return asked;
}

const scrollTop = (page: Page) =>
  page.evaluate(() => document.querySelector(".conversation-scroll")!.scrollTop);

test("scrolling back past a long turn's window loads it back to the prompt, keeping the reader's place", async ({
  page,
}) => {
  // 80 rounds of narration overflow the viewport, so nothing loads until the reader scrolls up.
  const asked = await open(page, { rounds: 80, window: 100 });
  await expect(page.getByText("Narration 79", { exact: true })).toBeVisible();
  await expect(page.getByText("Narration 30", { exact: true })).toBeVisible();
  expect(asked).toEqual([]);
  expect(await scrollTop(page)).toBeGreaterThan(0);

  // Reading back: the oldest narration held stays where it was as each page goes in above it.
  const place = () =>
    page.evaluate(() => {
      const text = [...document.querySelectorAll("p")].find(
        (node) => node.textContent === "Narration 30",
      );

      return Math.round(text!.getBoundingClientRect().top);
    });

  await page.evaluate(() => {
    const scroll = document.querySelector(".conversation-scroll")!;
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  const before = await place();
  await expect.poll(() => asked.length > 0).toBe(true);
  await expect.poll(async () => (await scrollTop(page)) > 0).toBe(true);
  expect(Math.abs((await place()) - before)).toBeLessThanOrEqual(2);

  // Keep scrolling to the top until the prompt that started the turn is shown.
  await expect
    .poll(async () => {
      await page.evaluate(() => {
        const scroll = document.querySelector(".conversation-scroll")!;
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event("scroll"));
      });

      const prompt = await page.evaluate(
        () => document.querySelector(".prompt-bubble")?.textContent ?? "",
      );

      return prompt.includes(PROMPT);
    })
    .toBe(true);
  await expect(page.getByRole("button", { name: "Show earlier messages" })).toHaveCount(0);
  expect(asked).toEqual([...new Set(asked)]);
});

test("a window too short to scroll loads earlier messages until the prompt shows", async ({
  page,
}) => {
  // Two pages of 20 hold the 25 entries before this two-entry window.
  const asked = await open(page, { rounds: 12, window: 2 });
  await expect(page.getByText(PROMPT, { exact: true })).toBeVisible();
  expect(asked).toEqual([23, 3]);
});
