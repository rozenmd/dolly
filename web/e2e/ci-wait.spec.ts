import { ciWaitMessage } from "../../src/ci-wait-message";
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

const HEADLINE = "PR #8: 1 failed, 1 still running";
const TRIGGER = "1 check(s) failed on aaaaaaa while 1 still run: lint (https://ci.example/lint).";
const NEXT = "Fix whatever failed and push again";

/** A session where the agent waited on PR checks and a failure woke it. */
function entries(start: number) {
  return [
    {
      id: 1,
      kind: "pi.user",
      model: [{ role: "user", content: "Push the fix and wait for CI", timestamp: start }],
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
              id: "call_wait",
              name: "wait_for",
              arguments: {
                kind: "pr_checks",
                repository: "octocat/project",
                number: 8,
                prompt: NEXT,
              },
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
          toolCallId: "call_wait",
          toolName: "wait_for",
          content: [
            {
              type: "text",
              text: JSON.stringify({ id: "22", waiting_on: "octocat/project#8 checks" }),
            },
          ],
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
          content: [{ type: "text", text: "Waiting for CI; I'll pick it up when checks report." }],
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
          content: ciWaitMessage("22", {
            outcome: "failed",
            headline: HEADLINE,
            detail: TRIGGER,
            prompt: NEXT,
          }),
          timestamp: start + 6 * 60_000,
        },
      ],
    },
    {
      id: 6,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Lint failed on an unused import; fixing it." }],
          timestamp: start + 7 * 60_000,
          stopReason: "stop",
        },
      ],
    },
  ];
}

type Wait = {
  id: string;
  waiting_on: string;
  timeout: string;
  next_poll: string;
  last_seen?: string;
};

async function open(page: Page, active?: Wait) {
  const start = Date.now() - 8 * 60_000;
  let current = active ?? null;
  const cancelled: string[] = [];

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions")
      return route.fulfill({
        json: [{ id: "ci", model: "gpt-6-sol", title: "CI wait", repository: "", updatedAt: 1 }],
      });

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/sessions/ci/wait" && route.request().method() === "DELETE") {
      cancelled.push(current?.id ?? "");
      current = null;

      return route.fulfill({ json: { state: "cancelled" } });
    }

    if (path === "/api/sessions/ci/wait") return route.fulfill({ json: { wait: current } });

    if (path === "/api/sessions/ci/scheduled")
      return route.fulfill({ json: { now: new Date().toISOString(), scheduled: [] } });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.routeWebSocket("**/api/sessions/ci/events", (socket) =>
    socket.send(JSON.stringify({ entries: entries(start), docs: { "pi.live": {} } })),
  );
  await page.goto("/", { waitUntil: "networkidle" });

  return { cancelled };
}

test("a CI wake-up reads as an outcome notice, and wait_for's row names the PR", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByText("Lint failed on an unused import; fixing it.")).toBeVisible();

  // Not the owner's bubble, and none of the model-facing wording shows.
  await expect(page.getByRole("article", { name: "user message" })).toHaveCount(1);
  await expect(page.getByText("[CI wait", { exact: false })).toHaveCount(0);
  await expect(page.getByText("This is system context", { exact: false })).toHaveCount(0);

  const notice = page.getByRole("group", { name: "CI wait result" });
  await expect(notice).toHaveAttribute("data-outcome", "failed");
  await expect(notice).toContainText(HEADLINE);
  await expect(page.getByText(TRIGGER, { exact: false })).not.toBeVisible();
  await notice.getByText(HEADLINE, { exact: true }).click();
  await expect(notice).toContainText("lint");
  await expect(notice).toContainText(`Then: ${NEXT}`);

  await page.getByText("Worked", { exact: true }).first().click();
  await page.getByText("1 step", { exact: true }).click();
  await expect(page.getByText("octocat/project#8", { exact: true })).toBeVisible();
});

test("while the agent waits on CI, the composer says on what, and the owner can stop it", async ({
  page,
}) => {
  const { cancelled } = await open(page, {
    id: "33",
    waiting_on: "octocat/project#8 checks",
    timeout: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    next_poll: new Date(Date.now() + 20_000).toISOString(),
    last_seen: "3 passed, 0 failed, 2 pending of 5 on aaaaaaa",
  });

  const strip = page.getByRole("region", { name: "Waiting on CI" });
  await expect(strip).toContainText("Waiting on octocat/project#8 checks");
  await expect(strip).toContainText(/next check in \d+s/);
  await expect(strip).toContainText("last seen 3 passed, 0 failed, 2 pending of 5 on aaaaaaa");

  await strip.getByRole("button", { name: "Stop waiting on CI" }).click();
  await expect(strip).toHaveCount(0);
  expect(cancelled).toEqual(["33"]);
});

test("there's no CI strip when nothing is being waited on", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Lint failed on an unused import; fixing it.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Waiting on CI" })).toHaveCount(0);
});
