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

const PROMPT = "Start the migration now and keep going until it is done";

/** A session where the agent scheduled a check-back that has since been delivered. */
function entries(start: number) {
  const iso = (minutes: number) => new Date(start + minutes * 60_000).toISOString();

  return [
    {
      id: 1,
      kind: "pi.user",
      model: [{ role: "user", content: "In two hours, start the migration", timestamp: start }],
    },
    {
      id: 2,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_schedule",
              name: "schedule_prompt",
              arguments: { in_minutes: 120, prompt: PROMPT },
            },
          ],
          timestamp: start + 1000,
          stopReason: "toolUse",
        },
      ],
    },
    {
      id: 3,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "call_schedule",
          toolName: "schedule_prompt",
          content: [{ type: "text", text: JSON.stringify({ id: "16", at: iso(120) }) }],
          timestamp: start + 2000,
        },
      ],
    },
    {
      id: 4,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Scheduled for two hours from now." }],
          timestamp: start + 3000,
          stopReason: "stop",
        },
      ],
    },
    {
      id: 5,
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: `[Scheduled prompt 16, set at ${iso(0)} for ${iso(120)}]\n\n${PROMPT}`,
          timestamp: start + 120 * 60_000,
        },
      ],
    },
    {
      id: 6,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Migration started." }],
          timestamp: start + 121 * 60_000,
          stopReason: "stop",
        },
      ],
    },
  ];
}

type Pending = { id: string; at: string; prompt: string; source: "agent" | "owner" };

async function open(page: Page) {
  const start = Date.now() - 125 * 60_000;

  let pending: Pending[] = [
    {
      id: "41",
      at: new Date(Date.now() + 45 * 60_000).toISOString(),
      prompt: "Check CI on the migration PR",
      source: "agent",
    },
  ];

  const created: { content: string; at: string; requestId: string }[] = [];
  const cancelled: string[] = [];

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/sessions")
      return route.fulfill({
        json: [
          { id: "later", model: "gpt-6-sol", title: "Scheduled", repository: "", updatedAt: 1 },
        ],
      });

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/sessions/later/scheduled" && request.method() === "POST") {
      const body = request.postDataJSON();
      created.push(body);
      pending = [...pending, { id: "50", at: body.at, prompt: body.content, source: "owner" }];

      return route.fulfill({ status: 201, json: { id: "50", at: body.at } });
    }

    if (path === "/api/sessions/later/scheduled")
      return route.fulfill({ json: { now: new Date().toISOString(), scheduled: pending } });

    if (path.startsWith("/api/sessions/later/scheduled/") && request.method() === "DELETE") {
      const id = path.split("/").at(-1)!;
      cancelled.push(id);
      pending = pending.filter((item) => item.id !== id);

      return route.fulfill({ json: { id, state: "cancelled" } });
    }

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/later/events", (socket) =>
    socket.send(JSON.stringify({ entries: entries(start), docs: { "pi.live": {} } })),
  );
  await page.goto("/", { waitUntil: "networkidle" });

  return { created, cancelled };
}

test("a delivered scheduled prompt reads as a notice, and its tool call says when and what", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText("Migration started.", { exact: true })).toBeVisible();

  // Not the owner's bubble: only the typed request is a user message, and the label is gone.
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(1);
  await expect(page.getByText("[Scheduled prompt", { exact: false })).toHaveCount(0);

  const notice = page.getByRole("group", { name: "scheduled message" });
  await expect(notice).toContainText("Scheduled message");
  await expect(page.getByText(PROMPT, { exact: true })).not.toBeVisible();
  await notice.getByText("Scheduled message", { exact: true }).click();
  await expect(page.getByText(PROMPT, { exact: true })).toBeVisible();

  await page.getByText("Worked", { exact: true }).click();
  await page.getByText("1 step", { exact: true }).click();
  await expect(page.getByText(`in 2h · ${PROMPT}`, { exact: true })).toBeVisible();
});

test("send later schedules the draft for a quick pick, lists it with the agent's, and cancels", async ({
  page,
}) => {
  const { created, cancelled } = await open(page);
  const trigger = page.getByRole("button", { name: "Send later (1 scheduled)", exact: true });
  await expect(trigger).toBeVisible();

  // With no draft the menu still lists what is scheduled, but nothing can be picked.
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Send later" });
  await expect(menu).toContainText("Check CI on the migration PR");
  await expect(menu).toContainText("agent");
  await expect(menu).toContainText("Type a message to send it later");
  await expect(menu.getByRole("menuitem", { name: "Custom time…", exact: true })).toBeDisabled();
  await page.press("Escape");

  await page.getByLabel("Message your agent").fill("Review the PR");
  await trigger.click();
  const tomorrow = menu.getByRole("menuitem", { name: /^Tomorrow at / });
  await expect(tomorrow).not.toBeDisabled();
  await tomorrow.click();

  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Send later (2 scheduled)", exact: true }),
  ).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0]!.content).toBe("Review the PR");
  expect(created[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);

  const at = new Date(created[0]!.at);
  const expected = new Date();
  expected.setDate(expected.getDate() + 1);
  expected.setHours(9, 0, 0, 0);
  expect(at.getTime()).toBe(expected.getTime());

  await page.getByRole("button", { name: "Send later (2 scheduled)", exact: true }).click();
  await expect(menu).toContainText("Review the PR");
  await menu.getByRole("button", { name: "Cancel scheduled message", exact: true }).first().click();
  await expect(menu).not.toContainText("Check CI on the migration PR");
  expect(cancelled).toEqual(["41"]);
});
