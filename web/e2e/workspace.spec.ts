import * as Schema from "effect/Schema";
import { expect, test, type Page } from "./browser";
import type { Live } from "../../src/transcript";
import type { DefaultModel } from "../src/lib/api";

const app = {
  connected: true,
  owner: "octocat",
  appSlug: "dolly-test",
  installUrl: "https://github.com/apps/dolly-test/installations/new",
  settingsUrl: "https://github.com/settings/apps/dolly-test",
  ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  senders: ["octocat"],
};

const signedIn = { github: app, ownerClaimed: true, user: { login: "octocat" } };

for (const width of [1280, 320]) {
  test(`shows live activity and a ticking timer at ${width}px with tool output collapsed by default`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route("**/api/**", (route) => {
      if (new URL(route.request().url()).pathname === "/api/sessions")
        return route.fulfill({
          json: [
            {
              id: "progress",
              model: "gpt-6-sol",
              title: "Run tests",
              repository: "",
              updatedAt: 1,
            },
          ],
        });

      if (new URL(route.request().url()).pathname === "/api/auth")
        return route.fulfill({ json: signedIn });

      return route.fulfill({ json: { state: "connected" } });
    });
    let push: (live: typeof Live.Type, done?: boolean) => void = () => {};

    await page.routeWebSocket("**/api/sessions/progress/events", (socket) => {
      push = (live, done = false) =>
        socket.send(
          JSON.stringify({
            entries: [
              {
                id: 1,
                kind: "pi.user",
                model: [{ role: "user", content: "Run tests", timestamp: Date.now() - 5000 }],
              },
              ...(done
                ? [
                    {
                      id: 2,
                      kind: "pi.assistant",
                      model: [{ role: "assistant", content: "All passed." }],
                    },
                  ]
                : []),
            ],
            docs: { "pi.live": live },
          }),
        );
      push({
        run: {},
        generation: {
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Private reasoning" }],
          },
        },
      });
    });
    await page.goto("/", { waitUntil: "networkidle" });
    const status = page.locator(".running-footer");
    await expect(status).toContainText("Thinking");
    await expect(page.getByText("Private reasoning")).toHaveCount(0);
    const initial = await status.textContent();
    await expect.poll(() => status.textContent()).not.toBe(initial);
    push({
      run: {},
      tools: [{ callId: "test", name: "shell", status: "running", output: "Tests 3/10 passed" }],
    });
    await expect(status).toContainText("Running shell");
    const group = page.locator("details.step-group");
    await expect(group).toHaveJSProperty("open", false);
    await group.locator("> summary").click();
    const step = page.locator("details.step");
    await expect(step.locator("> summary")).toBeVisible();
    await expect(step).toHaveJSProperty("open", false);
    await expect(page.getByText("Tests 3/10 passed")).not.toBeVisible();
    await step.locator("> summary").click();
    await expect(page.getByText("Tests 3/10 passed")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`live-progress-${width}.png`) });
    push({
      run: {},
      generation: { message: { role: "assistant", content: "All passed" } },
    });
    await expect(status).toContainText("Responding");
    // Streaming text is held back so the reply appears in one piece, without layout shift.
    await expect(page.getByText("All passed", { exact: true })).toHaveCount(0);
    push({}, true);
    await expect(status).toHaveCount(0);
    await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
      "All passed.",
    );
  });
}

// Main now streams transcripts over WebSockets. Reuse each test's HTTP snapshot fixture
// for the initial socket snapshot and push another only after a message/abort mutation.
test.beforeEach(async ({ page }) => {
  const updates = new Set<() => Promise<void>>();
  page.on("requestfinished", (request) => {
    const path = new URL(request.url()).pathname;

    if (
      (request.method() === "POST" && /\/(messages|abort|steer|edit)$/.test(path)) ||
      (["PUT", "DELETE"].includes(request.method()) && /\/queue(\/\d+)?$/.test(path))
    )
      for (const update of updates) void update();
  });
  await page.routeWebSocket("**/api/sessions/*/events", (socket) => {
    let active = true;
    const path = new URL(socket.url()).pathname.replace(/\/events$/, "");

    const update = async () => {
      try {
        const text = await page.evaluate(async (path) => await (await fetch(path)).text(), path);

        if (active) socket.send(text);
      } catch {
        if (active) socket.close();
      }
    };

    updates.add(update);
    socket.onClose(() => {
      active = false;
      updates.delete(update);
    });
    void update();
  });
});

test("queues a message while running and promotes it with Send now, including after reload", async ({
  page,
}) => {
  const items: { id: number; mode: string; content: string }[] = [];
  let submissions = 0;
  let promotions = 0;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions")
      return route.fulfill({
        json: [
          {
            id: "queue-session",
            model: "gpt-6-luna",
            title: "Queue test",
            repository: "",
            updatedAt: 1,
          },
        ],
      });

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/chatgpt") return route.fulfill({ json: { state: "connected" } });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    if (path === "/api/sessions/queue-session/messages") {
      submissions++;
      items.push({ id: 42, mode: "followUp", content: route.request().postDataJSON().content });

      return route.fulfill({ status: 202, json: { submissionId: 42 } });
    }

    if (path === "/api/sessions/queue-session/queue/42/steer") {
      promotions++;

      if (promotions === 1) return route.fulfill({ status: 502, json: { error: "Try again" } });
      items[0]!.mode = "steer";

      return route.fulfill({ status: 202, json: { state: "steering" } });
    }

    if (path === "/api/sessions/queue-session")
      return route.fulfill({
        json: {
          entries: [
            { id: 1, kind: "pi.user", model: [{ role: "user", content: "Original task" }] },
          ],
          docs: { "pi.live": { run: {} }, "pi.inbox": { items } },
        },
      });

    return route.fulfill({ json: {} });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("Message your agent").fill("Use pnpm instead");
  await page
    .getByRole("button", { name: "Queue until the current turn finishes", exact: true })
    .click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Use pnpm instead");
  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  await page.reload();
  await expect(queue).toContainText("Use pnpm instead");
  await queue.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Try again");
  await queue.getByRole("button", { name: "Send now", exact: true }).click();
  // A steer leaves the queue and waits in the conversation for the turn's next step.
  await expect(queue).toHaveCount(0);
  const steering = page.getByRole("article", { name: "steering message" });
  await expect(steering).toContainText("Use pnpm instead");
  await expect(steering).toContainText("Sending after the current step");
  expect(submissions).toBe(1);
  expect(promotions).toBe(2);
});

test("edits, deletes, reorders and steers queued messages, and stops on Escape twice", async ({
  page,
}) => {
  type Item = { id: number; mode: string; content: string };

  let items: Item[] = [
    { id: 41, mode: "followUp", content: "Run the tests" },
    { id: 42, mode: "followUp", content: "Update the README" },
    { id: 43, mode: "followUp", content: "Review feedback" },
  ];

  const sent: { content: string; steer?: boolean }[] = [];
  const orders: number[][] = [];
  const deleted: number[] = [];
  let aborts = 0;
  let next = 50;

  const remove = (id: number) => {
    const item = items.find((candidate) => candidate.id === id);
    items = items.filter((candidate) => candidate.id !== id);

    return item;
  };

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/sessions")
      return route.fulfill({
        json: [
          {
            id: "queue-session",
            model: "gpt-6-luna",
            title: "Queue",
            repository: "",
            updatedAt: 1,
          },
        ],
      });

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/chatgpt") return route.fulfill({ json: { state: "connected" } });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    if (path === "/api/sessions/queue-session/messages") {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ content: Schema.String, steer: Schema.optional(Schema.Boolean) }),
      )(route.request().postDataJSON());

      sent.push({ content: body.content, steer: body.steer });
      items.push({ id: next, mode: body.steer ? "steer" : "followUp", content: body.content });

      return route.fulfill({ status: 202, json: { submissionId: next++ } });
    }

    if (path === "/api/sessions/queue-session/queue" && method === "PUT") {
      const { order } = Schema.decodeUnknownSync(
        Schema.Struct({ order: Schema.Array(Schema.Number) }),
      )(route.request().postDataJSON());

      orders.push([...order]);
      const byId = new Map(items.map((item) => [item.id, item]));
      items = [
        ...order.map((id) => byId.get(id)!),
        ...items.filter((item) => item.mode === "steer"),
      ];

      return route.fulfill({ json: { state: "reordered" } });
    }

    const edit = /^\/api\/sessions\/queue-session\/queue\/(\d+)\/edit$/.exec(path);

    if (edit) {
      const item = remove(Number(edit[1]));

      return route.fulfill({ json: { content: item?.content ?? "" } });
    }

    const withdraw = /^\/api\/sessions\/queue-session\/queue\/(\d+)$/.exec(path);

    if (withdraw && method === "DELETE") {
      deleted.push(Number(withdraw[1]));
      remove(Number(withdraw[1]));

      return route.fulfill({ json: { state: "withdrawn" } });
    }

    if (path === "/api/sessions/queue-session/abort") {
      aborts++;

      return route.fulfill({ status: 202, json: {} });
    }

    if (path === "/api/sessions/queue-session")
      return route.fulfill({
        json: {
          entries: [
            { id: 1, kind: "pi.user", model: [{ role: "user", content: "Original task" }] },
          ],
          docs: {
            "pi.live": { run: {} },
            "pi.inbox": { items },
            "app.owner-inputs": { submissions: [41, 42, ...sent.map((_, index) => 50 + index)] },
          },
        },
      });

    return route.fulfill({ json: {} });
  });

  await page.goto("/", { waitUntil: "networkidle" });
  const queue = page.getByRole("region", { name: "Queued messages" });
  const field = page.getByLabel("Message your agent");
  await expect(queue).toContainText("3 messages queued");

  // Only text the owner typed offers Edit; every message can be deleted or sent now.
  const rows = queue.getByRole("listitem");
  await expect(rows.nth(0).getByRole("button", { name: "Edit in composer" })).toHaveCount(1);
  await expect(rows.nth(2).getByRole("button", { name: "Edit in composer" })).toHaveCount(0);
  await expect(rows.nth(2).getByRole("button", { name: "Delete queued message" })).toHaveCount(1);

  // Edit moves the text back into the composer and out of the queue.
  await field.fill("Draft");
  await rows.nth(1).getByRole("button", { name: "Edit in composer" }).click();
  await expect(field).toHaveValue("Draft\n\nUpdate the README");
  await expect(queue).toContainText("2 messages queued");
  await expect(queue).not.toContainText("Update the README");

  // Delete withdraws it.
  await field.fill("");
  await queue
    .getByRole("listitem")
    .nth(1)
    .getByRole("button", { name: "Delete queued message" })
    .click();
  await expect(queue).toContainText("1 message queued");
  expect(deleted).toEqual([43]);

  // Enter queues while the agent works; Ctrl+Enter steers into the running turn.
  await field.fill("Then lint");
  await field.press("Enter");
  await expect(queue).toContainText("Then lint");
  await field.fill("Use pnpm");
  await field.press("Control+Enter");
  await expect(page.getByRole("article", { name: "steering message" })).toContainText("Use pnpm");
  await expect(queue).not.toContainText("Use pnpm");
  expect(sent).toEqual([
    { content: "Then lint", steer: false },
    { content: "Use pnpm", steer: true },
  ]);

  // The handle reorders from the keyboard.
  await queue.getByRole("button", { name: "Reorder: 2 of 2" }).press("ArrowUp");
  await expect.poll(() => orders).toEqual([[50, 41]]);
  await expect(queue.getByRole("listitem").nth(0)).toContainText("Then lint");

  // The send button's menu makes Enter steer, and hands queueing to Ctrl+Enter.
  await field.fill("Swap");
  const send = page.getByRole("button", { name: "Queue until the current turn finishes" });
  await send.dispatchEvent("contextmenu");
  await page.getByRole("menuitemradio", { name: /Steer into running turn/ }).click();
  await expect(
    page.getByRole("button", { name: "Steer into the running turn", exact: true }),
  ).toHaveCount(1);
  await field.press("Control+Enter");
  await expect(queue).toContainText("Swap");
  expect(sent.at(-1)).toEqual({ content: "Swap", steer: false });

  // Escape twice stops the run; once does not.
  await field.press("Escape");
  expect(aborts).toBe(0);
  await field.press("Escape");
  await expect.poll(() => aborts).toBe(1);

  // Put the default back for later tests sharing this browser's storage.
  await page.evaluate(() => localStorage.removeItem("dolly-busy-send"));
});

test("one composer pill switches the session's model, effort, speed and fallback, rolls back a refusal, and saves and restores defaults", async ({
  page,
}) => {
  const changes: unknown[] = [];
  const saved: unknown[] = [];

  let defaults: DefaultModel = {
    model: null,
    effective: "gpt-6-luna",
    thinkingLevel: "medium",
    speed: "standard",
    autoFallback: true,
    ultrafastAvailable: false,
  };

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/sessions")
      return route.fulfill({
        json: [
          {
            id: "pill",
            model: "gpt-6-luna",
            thinkingLevel: "medium",
            title: "Model pill",
            repository: "",
            updatedAt: 1,
          },
        ],
      });

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    if (path === "/api/settings/model") {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        saved.push(body);
        defaults = { ...defaults, ...body, effective: body.model ?? defaults.effective };
      }

      return route.fulfill({ json: defaults });
    }

    if (path === "/api/sessions/pill/settings") {
      const body = route.request().postDataJSON();
      changes.push(body);

      return body.model?.startsWith("claude-")
        ? route.fulfill({ status: 409, json: { error: "Connect your Claude subscription first" } })
        : route.fulfill({ json: body });
    }

    if (path === "/api/sessions/pill")
      return route.fulfill({
        json: {
          entries: [{ id: 1, kind: "pi.user", model: [{ role: "user", content: "Hi" }] }],
          docs: {},
        },
      });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });

  const pill = page.getByRole("button", { name: /^Model:/ });
  await expect(pill).toHaveText("GPT-6 LunaMedium");
  await expect(page.getByRole("button", { name: "Thinking effort" })).toHaveCount(0);

  await pill.click();
  const menu = page.getByRole("menu", { name: "Model settings" });
  await expect(menu).toContainText("GPT-6 Luna");
  await menu.getByRole("menuitem", { name: /^Model/ }).click();
  await page.getByRole("option", { name: "GPT-6.2 Sol" }).click();
  await expect(pill).toHaveText("GPT-6.2 SolMedium");

  await pill.click();
  await menu.getByRole("menuitem", { name: /^Effort/ }).click();
  await page.getByRole("option", { name: "Extra high" }).click();
  await expect(pill).toHaveText("GPT-6.2 SolExtra high");

  await pill.click();
  await menu.getByRole("menuitem", { name: /^Model/ }).click();
  await page.getByRole("option", { name: "Claude Opus 5.5" }).click();
  await expect(page.getByRole("alert")).toContainText("Connect your Claude subscription first");
  await expect(pill).toHaveText("GPT-6.2 SolExtra high");

  // Speed and auto-fallback live in the same menu; auto-fallback toggles in place.
  await pill.click();
  await menu.getByRole("menuitem", { name: /^Speed/ }).click();
  await page.getByRole("option", { name: /^Fast/ }).click();
  await expect(pill).toHaveAttribute("data-speed", "fast");
  await pill.click();
  const fallback = menu.getByRole("menuitemcheckbox", { name: /^Auto-fallback/ });
  await expect(fallback).toHaveAttribute("aria-checked", "true");
  await fallback.click();
  await expect(fallback).toHaveAttribute("aria-checked", "false");

  // Set as default saves every setting; the menu then shows it as the default.
  await menu.getByRole("menuitem", { name: "Set as default" }).click();
  await expect.poll(() => saved.length).toBe(1);
  await pill.click();
  await expect(menu.getByRole("menuitem", { name: "Set as default" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(menu.getByRole("menuitem", { name: "Reset to default" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // Changing a setting enables Reset, which restores the saved defaults in one request.
  await menu.getByRole("menuitem", { name: /^Effort/ }).click();
  await page.getByRole("option", { name: "Low" }).click();
  await expect(pill).toHaveText("GPT-6.2 SolLow");
  await pill.click();
  await menu.getByRole("menuitem", { name: "Reset to default" }).click();
  await expect(pill).toHaveText("GPT-6.2 SolExtra high");

  expect(changes).toEqual([
    { model: "gpt-6.2-sol" },
    { thinkingLevel: "xhigh" },
    { model: "claude-opus-5-5" },
    { speed: "fast" },
    { autoFallback: false },
    { thinkingLevel: "low" },
    { model: "gpt-6.2-sol", thinkingLevel: "xhigh", speed: "fast", autoFallback: false },
  ]);
  expect(saved).toEqual([
    { model: "gpt-6.2-sol", thinkingLevel: "xhigh", speed: "fast", autoFallback: false },
  ]);
});

test("connects Claude without ChatGPT, explicitly tests Worker inference, and starts a Claude conversation", async ({
  page,
}) => {
  const token = `sk-ant-oat01-${"a".repeat(64)}`;
  let connected = false;
  let probes = 0;
  let selectedModel = "";
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/chatgpt") return route.fulfill({ json: { state: "not_connected" } });

    if (path === "/api/auth/anthropic") {
      if (route.request().method() === "PUT") {
        expect(route.request().postDataJSON()).toEqual({ token });
        connected = true;
      }

      return route.fulfill({ json: { connected } });
    }

    if (path === "/api/auth/anthropic/test") {
      probes++;

      return route.fulfill({
        json: {
          ok: probes > 1,
          model: "claude-haiku-5-5",
          durationMs: 25,
          message:
            probes === 1
              ? "Anthropic returned HTTP 403 HTML instead of a model response. This may be an upstream edge block."
              : "Claude returned a live inference response from this Worker.",
          upstream: {
            status: probes === 1 ? 403 : 200,
            contentType: probes === 1 ? "text/html" : "text/event-stream",
            requestId: "request-test",
            rayId: "ray-test",
          },
        },
      });
    }

    if (path === "/api/settings/model")
      return route.fulfill({
        json: {
          model: null,
          effective: "claude-sonnet-5-5",
          thinkingLevel: "medium",
          speed: "standard",
          autoFallback: true,
          ultrafastAvailable: false,
        },
      });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    if (path === "/api/sessions") {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: selectedModel
            ? [
                {
                  id: "claude-session",
                  model: selectedModel,
                  title: "Say hello",
                  repository: "",
                  updatedAt: 1,
                },
              ]
            : [],
        });

      selectedModel = route.request().postDataJSON().model;

      return route.fulfill({ status: 201, json: { id: "claude-session", model: selectedModel } });
    }

    if (path === "/api/sessions/claude-session/messages")
      return route.fulfill({ status: 202, json: {} });

    if (path === "/api/sessions/claude-session")
      return route.fulfill({
        json: {
          entries: [
            { id: 1, kind: "pi.user", model: [{ role: "user", content: "Say hello" }] },
            {
              id: 2,
              kind: "pi.assistant",
              model: [
                { role: "assistant", content: [{ type: "text", text: "Hello from Claude" }] },
              ],
            },
          ],
          docs: {},
        },
      });

    return route.fulfill({ json: {} });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const connect = page.getByRole("dialog", { name: "Connect a model" });
  await connect.getByRole("button", { name: "Use Claude instead" }).click();
  await connect.getByLabel("Claude setup token").fill(token);
  await connect.getByRole("button", { name: "Save token" }).click();
  await expect(connect.getByLabel("Claude setup token")).toHaveValue("");
  expect(probes).toBe(0);
  await connect.getByRole("button", { name: "Test connection" }).click();
  await expect(connect.getByRole("alert")).toContainText("upstream edge block");
  await connect.getByRole("button", { name: "Test connection" }).click();
  await expect(connect.getByRole("status")).toContainText("live inference response");
  await page.screenshot({ path: test.info().outputPath("claude-connection.png") });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await connect.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("claude-connection-mobile.png") });
  await connect.getByRole("button", { name: "Continue with Claude" }).click();
  const composer = page.getByRole("dialog", { name: "New session" });
  // The server resolves the default, so a Claude-only owner gets Claude without a client override.
  const pill = composer.getByRole("button", { name: /^Model:/ });
  await expect(pill).toHaveAttribute("data-model", "");
  await expect(pill).toHaveText("Sonnet 5.5Medium");
  await pill.click();
  await composer.getByRole("menuitem", { name: /^Model/ }).click();
  await expect(composer.getByRole("option", { name: /^Default/ })).toContainText(
    "Claude Sonnet 5.5",
  );
  await composer.getByRole("option", { name: "Claude Haiku 5.5" }).click();
  await expect(pill).toHaveAttribute("data-model", "claude-haiku-5-5");
  await composer.getByLabel("Task", { exact: true }).fill("Say hello");
  expect(await composer.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  await expect(composer.getByRole("button", { name: "Create", exact: true })).toBeInViewport();
  await composer.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
    "Hello from Claude",
  );
  expect(selectedModel).toBe("claude-haiku-5-5");
  expect(await page.evaluate(() => localStorage.getItem("dolly.sessions.cache.v1"))).not.toContain(
    token,
  );
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
    "Hello from Claude",
  );
});

for (const outcome of ["answered", "failed", "retrying"] as const) {
  test(`renders an actual-shaped ${outcome} model response instead of a silent user-only transcript`, async ({
    page,
  }) => {
    const message =
      outcome === "answered"
        ? {
            role: "assistant",
            content: [{ type: "text", text: "Hi! How can I help?" }],
            stopReason: "stop",
          }
        : {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "The selected model is unavailable for this account",
          };

    let live: typeof Live.Type = {};

    if (outcome === "failed") {
      const failure = {
        first: 22,
        taskId: 26,
        inputs: [21],
        reason: "model_error",
        detail: message.errorMessage,
      };

      live = { runFailure: failure };
    } else if (outcome === "retrying")
      live = {
        run: { taskId: 26, inputs: [21], turns: 0 },
        generation: {
          attempt: 1,
          retry: { at: Date.now() + 60_000, error: "Provider is temporarily unavailable" },
        },
      };

    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === "/api/auth") return route.fulfill({ json: signedIn });

      if (path === "/api/sessions")
        return route.fulfill({
          json: [
            {
              id: "response-session",
              model: "gpt-6.1-terra",
              title: "hi",
              repository: "octocat/project",
              updatedAt: 1,
            },
          ],
        });

      if (path === "/api/sessions/response-session")
        return route.fulfill({
          json: {
            conversation: { id: 15 },
            entries: [
              {
                id: 22,
                kind: "pi.user",
                model: [{ role: "user", content: "hi", timestamp: 1_000 }],
              },
              {
                id: 25,
                kind: "pi.system",
                model: [{ role: "system", content: "Hidden internal prompt" }],
              },
              { id: 27, kind: "pi.assistant", model: [{ ...message, timestamp: 2_000 }] },
            ],
            docs: { "pi.live": live },
          },
        });

      return route.fulfill({ json: { state: "connected" } });
    });
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("article", { name: "user message" })).toContainText("hi");
    await expect(page.getByText("Hidden internal prompt")).toHaveCount(0);

    if (outcome === "answered") {
      await expect(page.getByRole("article", { name: "assistant message" })).toContainText(
        "Hi! How can I help?",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
    } else if (outcome === "failed") {
      await expect(page.getByRole("alert")).toContainText(
        "The selected model is unavailable for this account",
      );
      await expect(page.getByRole("complementary", { name: "Session summary" })).toContainText(
        "Failed",
      );
      await page.reload();
      await expect(page.getByRole("alert")).toContainText(
        "The selected model is unavailable for this account",
      );
      await page.screenshot({ path: test.info().outputPath("model-failure.png") });
    } else {
      await expect(page.getByText(/Retrying in/)).toContainText(
        "Provider is temporarily unavailable",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("complementary", { name: "Session summary" })).toContainText(
        "Working",
      );
    }
  });
}

for (const repository of ["octocat/project", ""]) {
  test(`plus opens a task composer in the current ${repository ? "repository" : "repo-less"} context and retries without duplicating sessions`, async ({
    page,
  }) => {
    const source = {
      id: "current",
      model: "gpt-6.1-terra",
      title: "Current task",
      repository,
      updatedAt: 1,
    };

    const creates: unknown[] = [];
    const messages: { content: string; requestId: string }[] = [];

    const config = repository
      ? { repository, ref: "develop", networkHosts: ["registry.npmjs.org"] }
      : null;

    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === "/api/auth") return route.fulfill({ json: signedIn });

      if (path === "/api/integrations/github/repositories")
        return route.fulfill({
          json: {
            repositories: [
              {
                fullName: "octocat/project",
                defaultBranch: "main",
                private: true,
                description: null,
              },
            ],
          },
        });

      if (path === "/api/sessions/current")
        return route.fulfill({
          json: {
            entries: [],
            docs: { "app.workspace": { config, activeRepository: "octocat/other" } },
          },
        });

      if (path === "/api/sessions") {
        if (route.request().method() === "GET") return route.fulfill({ json: [source] });
        creates.push(route.request().postDataJSON());

        return route.fulfill({ json: { id: "created", model: source.model } });
      }

      if (path === "/api/sessions/created/messages") {
        messages.push(route.request().postDataJSON());

        return route.fulfill(
          messages.length === 1
            ? { status: 502, json: { error: "Temporary failure" } }
            : { status: 202, json: {} },
        );
      }

      if (path === "/api/sessions/created")
        return route.fulfill({ json: { entries: [], docs: {} } });

      return route.fulfill({ json: { state: "connected" } });
    });

    if (!repository) await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/", { waitUntil: "networkidle" });

    const navigation = repository
      ? page.getByRole("complementary", { name: "Workspace navigation" })
      : page.locator(".header-actions");

    await navigation.getByRole("button", { name: "New session" }).click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await expect(dialog.getByLabel("Repository", { exact: true })).toHaveAttribute(
      "data-value",
      repository,
    );
    // Model settings start from the owner's defaults, not the open session.
    await expect(dialog.getByRole("button", { name: /^Model:/ })).toHaveAttribute("data-model", "");
    await expect(dialog.getByLabel("Workspace name")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
    expect(creates).toHaveLength(0);
    await dialog.getByLabel("Task", { exact: true }).fill("Fix the failing tests");
    await page.screenshot({ path: test.info().outputPath("new-session-composer.png") });
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Temporary failure");
    await expect(dialog.getByLabel("Task", { exact: true })).toHaveValue("Fix the failing tests");
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const defaults = { thinkingLevel: "medium", speed: "standard", autoFallback: true };
    expect(creates).toEqual([config ? { ...defaults, workspace: config } : defaults]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(messages[1]);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix the failing tests");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test("enrolls an App repository and anchors a new workspace to its default branch", async ({
  page,
}) => {
  let enrolled = false;
  let created: unknown;

  const repository = {
    fullName: "octocat/project",
    defaultBranch: "develop",
    private: true,
    description: "Our project",
  };

  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/auth") return route.fulfill({ json: signedIn });

    if (url.pathname === "/api/integrations/github/repositories") {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toEqual({ repository: repository.fullName });
        enrolled = true;

        return route.fulfill({ json: { repository } });
      }

      return route.fulfill({
        json: {
          repositories: url.searchParams.has("available")
            ? [{ ...repository, registered: enrolled }]
            : enrolled
              ? [repository]
              : [],
        },
      });
    }

    if (url.pathname === "/api/sessions") {
      created = route.request().postDataJSON();

      return route.fulfill({ json: { id: "new-session", model: "gpt-6-sol" } });
    }

    if (url.pathname === "/api/sessions/new-session")
      return route.fulfill({ json: { entries: [], docs: {} } });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.getByLabel("Task").fill("Cross-repo task");
  await dialog.getByRole("button", { name: "Repository", exact: true }).click();
  await dialog.getByRole("button", { name: "New repository…" }).click();
  await dialog.getByLabel("Find a repository").fill("project");
  await expect(dialog).toContainText("Private · develop · Our project");
  await dialog.getByRole("button", { name: "Enroll", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Repository", exact: true })).toHaveAttribute(
    "data-value",
    "octocat/project",
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(created).toEqual({
    thinkingLevel: "medium",
    speed: "standard",
    autoFallback: true,
    workspace: { repository: "octocat/project", ref: "develop" },
  });
});

/** A browser that is already signed in with GitHub and ChatGPT, with no saved workspaces. */
async function signedInWorkspace(page: Page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    return route.fulfill({ json: { state: "connected" } });
  });
}

test("first run creates the GitHub App from dolly with the ingress URL filled in", async ({
  page,
}) => {
  const errors: string[] = [];
  let setup: unknown;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({
        json: { github: { connected: false }, ownerClaimed: false, user: null },
      });

    if (path === "/api/integrations/github/setup") {
      setup = route.request().postDataJSON();

      return route.fulfill({
        // Same-origin: Browser Run blocks navigation to local addresses.
        json: { connected: false, setupUrl: "/api/setup/github/test-state" },
      });
    }

    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Connect GitHub</title><h1>Create GitHub App</h1>",
    });
  });
  await page.goto("/?github=GitHub%20App%20owner%20does%20not%20match", {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("heading", { name: "Set up dolly" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("GitHub App owner does not match");
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByText("API token")).toHaveCount(0);
  await page.getByLabel("Your GitHub username").fill("octocat");
  await page.getByLabel("Ingress URL").fill("https://dolly-ingress.example.workers.dev/");
  await page.getByRole("button", { name: "Create GitHub App" }).click();
  await expect(page.getByRole("heading", { name: "Create GitHub App" })).toBeVisible();
  expect(setup).toEqual({
    owner: "octocat",
    ownerType: "personal",
    ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  });
  expect(errors).toEqual([]);
});

test("GitHub device sign-in claims dolly, then continues to ChatGPT", async ({ page }) => {
  let polls = 0;

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: false, user: null } });

    if (path === "/api/auth/github" && method === "POST")
      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://github.com/login/device",
          userCode: "WDJB-MJHT",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });

    if (path === "/api/auth/github") {
      polls += 1;

      if (polls === 1)
        return route.fulfill({ status: 502, json: { error: "Request failed; check Worker logs" } });

      return route.fulfill({ json: { state: "signed_in", login: "octocat" } });
    }

    return route.fulfill({ json: { state: "not_connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Sign in to dolly" })).toBeVisible();
  await expect(page.getByRole("link", { name: "its settings" })).toHaveAttribute(
    "href",
    app.settingsUrl,
  );
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("button", { name: "Copy code WDJB-MJHT" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/login/device",
  );
  await expect(page.getByRole("dialog", { name: "Connect a model" })).toBeVisible({
    timeout: 10_000,
  });
  expect(polls).toBe(2);
});

test("GitHub sign-in as someone other than the owner is refused with the reason", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: true, user: null } });

    if (method === "POST")
      return route.fulfill({
        json: {
          state: "awaiting_code",
          verificationUri: "https://github.com/login/device",
          userCode: "WDJB-MJHT",
          expiresAt: Date.now() + 900_000,
          pollAfterSeconds: 1,
        },
      });

    return route.fulfill({
      status: 403,
      json: {
        state: "denied",
        message: "You signed in as @intruder, but this dolly belongs to @octocat.",
      },
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "You signed in as @intruder, but this dolly belongs to @octocat.",
  );
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("device flow turned off links straight to the GitHub App's settings", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({ json: { github: app, ownerClaimed: true, user: null } });

    return route.fulfill({
      status: 409,
      json: { error: "Device flow is turned off for this GitHub App, so nobody can sign in." },
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("link", { name: "Open the app's settings" })).toHaveAttribute(
    "href",
    app.settingsUrl,
  );
});

test("settings show who is signed in and update the ingress URL and GitHub access", async ({
  page,
}) => {
  let ingress: unknown;
  let accounts: unknown;
  let senders: unknown;
  let signedOut = false;

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({ json: signedOut ? { ...signedIn, user: null } : signedIn });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    if (path === "/api/integrations/github/ingress") {
      ingress = route.request().postDataJSON();

      return route.fulfill({ json: { ingress: "https://new-ingress.example/hooks/github" } });
    }

    if (path === "/api/integrations/github/accounts") {
      if (route.request().method() === "PUT") accounts = route.request().postDataJSON();

      return route.fulfill({ json: { accounts: ["octocat"] } });
    }

    if (path === "/api/integrations/github/webhook") {
      senders = route.request().postDataJSON();

      return route.fulfill({ json: { configured: true } });
    }

    if (path === "/api/auth/session") {
      signedOut = true;

      return route.fulfill({ json: { signedIn: false } });
    }

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "New session" }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  // Settings is a page, and each section has its own URL.
  await expect(page).toHaveURL(/\/settings\/account$/);
  const nav = page.getByRole("navigation", { name: "Settings" });
  const main = page.locator("main");
  await expect(main).toContainText("Signed in as @octocat");
  await nav.getByRole("link", { name: "Repositories" }).click();
  await expect(page).toHaveURL(/\/settings\/repositories$/);
  await expect(main.getByRole("link", { name: "Add repositories" })).toHaveAttribute(
    "href",
    app.installUrl,
  );
  await nav.getByRole("link", { name: "GitHub" }).click();
  await expect(page).toHaveURL(/\/settings\/github$/);
  await main.getByLabel("Ingress URL").fill("https://new-ingress.example");
  await main.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(main).toContainText("GitHub now sends comments to this URL.");
  expect(ingress).toEqual({ url: "https://new-ingress.example/hooks/github" });
  await expect(main.getByLabel("Accounts dolly can work in")).toHaveValue("octocat");
  await expect(main.getByLabel("Who can run /dolly commands")).toHaveValue("octocat");
  await main.getByLabel("Accounts dolly can work in").fill("octocat, @acme");
  await main.getByLabel("Who can run /dolly commands").fill("octocat hubot");
  await main.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(main.getByText("Saved.", { exact: true })).toBeVisible();
  expect(accounts).toEqual({ accounts: ["octocat", "acme"] });
  expect(senders).toEqual({ senders: ["octocat", "hubot"] });
  // Leaving and returning keeps what was saved, and clearing the list saves an empty list.
  await nav.getByRole("link", { name: "Account" }).click();
  await nav.getByRole("link", { name: "GitHub" }).click();
  await expect(main.getByLabel("Who can run /dolly commands")).toHaveValue("octocat, hubot");
  await main.getByLabel("Who can run /dolly commands").fill("");
  await main.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(main.getByText("Saved.", { exact: true })).toBeVisible();
  expect(senders).toEqual({ senders: [] });
  // Automatic reviews are an automation now; the GitHub settings point there.
  await expect(main.getByRole("link", { name: "Automations" })).toHaveAttribute(
    "href",
    "/settings/automations",
  );
  // Loading /settings directly opens the first section.
  await page.goto("/settings", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/settings\/account$/);
  await main.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to dolly" })).toBeVisible();
  expect(signedOut).toBe(true);
});

test("mobile navigation and 320px layout", async ({ page }) => {
  await signedInWorkspace(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("dialog", { name: "New session" }).press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Feed" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).not.toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Feed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("authenticated create, send, stop, reload, and error recovery", async ({ page }) => {
  const entries: { id: number; kind: string; model: { role: string; content: string }[] }[] = [];
  let working = false;
  const requestIds: string[] = [];
  let failMessage = true;
  let stopped = false;
  await page.route("**/api/**", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/auth/chatgpt") return route.fulfill({ json: { state: "connected" } });

    if (path === "/api/sessions")
      return route.fulfill({ status: 201, json: { id: "test-session", model: "gpt-6-sol" } });

    if (path.endsWith("/messages")) {
      const body = route.request().postDataJSON();

      if (body.content === "Run tests") requestIds.push(body.requestId);

      if (failMessage && body.content === "Run tests") {
        failMessage = false;

        return route.fulfill({ status: 502, json: { error: "Temporary failure. Try again." } });
      }

      entries.push({
        id: entries.length + 1,
        kind: "pi.input",
        model: [{ role: "user", content: body.content }],
      });

      working = body.content === "Run tests";

      return route.fulfill({ status: 202, json: { submissionId: "submission-1" } });
    }

    if (path.endsWith("/abort")) {
      stopped = true;

      return route.fulfill({ json: { ok: true } });
    }

    return route.fulfill({ json: { entries, docs: working ? { "pi.live": { run: {} } } : {} } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("Task").fill("Fix flaky tests");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix flaky tests");
  await page.getByLabel("Message your agent").fill("Run tests");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Temporary failure. Try again.");
  await expect(page.getByLabel("Message your agent")).toHaveValue("Run tests");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByLabel("Message your agent")).toHaveValue("");
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  await expect(page.getByRole("article", { name: "user message" }).last()).toContainText(
    "Run tests",
  );
  await page.getByRole("button", { name: "Stop agent" }).click();
  await expect.poll(() => stopped).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fix flaky tests");
});

const awaitingRedirect = {
  state: "awaiting_redirect",
  authorizeUrl:
    "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&agent_name_hint=Dolly",
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  expiresAt: Date.now() + 600_000,
};

test("Sign in with ChatGPT links to approval, finishes with the pasted redirect, then opens a new workspace", async ({
  page,
}) => {
  const calls: string[] = [];
  const pasted: unknown[] = [];

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path !== "/api/auth/chatgpt") return route.fulfill({ status: 404, json: { error: "x" } });

    calls.push(method);

    if (method === "POST") return route.fulfill({ json: awaitingRedirect });

    if (method === "PUT") {
      pasted.push(JSON.parse(route.request().postData() ?? "null"));

      return pasted.length === 1
        ? route.fulfill({
            status: 400,
            json: { state: "error", error: "That address is from a different sign-in attempt." },
          })
        : route.fulfill({ json: { state: "connected" } });
    }

    return route.fulfill({
      json: calls.includes("POST") ? awaitingRedirect : { state: "not_connected" },
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "Connect a model" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  await expect(dialog.getByRole("link", { name: "Open ChatGPT" })).toHaveAttribute(
    "href",
    awaitingRedirect.authorizeUrl,
  );
  const address = dialog.getByLabel("Address of the page that didn't load");
  await address.fill("http://127.0.0.1:1455/auth/callback?code=old&state=stale");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "That address is from a different sign-in attempt.",
  );
  await address.fill("http://127.0.0.1:1455/auth/callback?code=abc&state=s&client_id=app_x");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible({
    timeout: 10_000,
  });
  expect(pasted).toEqual([
    { callbackUrl: "http://127.0.0.1:1455/auth/callback?code=old&state=stale" },
    { callbackUrl: "http://127.0.0.1:1455/auth/callback?code=abc&state=s&client_id=app_x" },
  ]);
});

test("a new session dialog opened while sessions load stays open when they arrive", async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let listed = false;

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (path === "/api/sessions" && route.request().method() === "GET") {
      if (!listed) {
        listed = true;
        await held;
      }

      return route.fulfill({
        json: [
          {
            id: "background",
            model: "gpt-6-sol",
            title: "Background session",
            repository: "",
            updatedAt: Date.now(),
          },
        ],
      });
    }

    if (path === "/api/sessions/background")
      return route.fulfill({ json: { entries: [], docs: {} } });

    return route.fulfill({ json: { state: "connected" } });
  });
  await page.goto("/");
  await page.locator(".header-actions").getByRole("button", { name: "New session" }).click();
  const dialog = page.getByRole("dialog", { name: "New session" });
  const task = dialog.getByLabel("Task", { exact: true });
  await task.fill("Half-typed task");
  release();
  // The loaded session is selected behind the dialog, which keeps the draft.
  await expect(page.locator(".workspace-header h1")).toHaveText("Background session");
  await expect(dialog).toBeVisible();
  await expect(task).toHaveValue("Half-typed task");
  await expect(task).toBeFocused();
});

test("cancelling ChatGPT sign-in ignores a connection that was already in flight", async ({
  page,
}) => {
  let deleted = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: signedIn });

    if (method === "DELETE") {
      deleted = true;
      // The Worker serialises DELETE behind the exchange already holding the account lock.
      await held;
      await new Promise((resolve) => setTimeout(resolve, 300));

      return route.fulfill({ json: { state: "not_connected" } });
    }

    if (method === "PUT") {
      await held;

      return route.fulfill({ json: { state: "connected" } });
    }

    return route.fulfill({ json: awaitingRedirect });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "Connect a model" });
  await dialog
    .getByLabel("Address of the page that didn't load")
    .fill("http://127.0.0.1:1455/auth/callback?code=abc&state=s&client_id=app_x");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => deleted).toBe(true);
  release();
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
});

test("starts steps collapsed and respects what the user opens or closes", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/sessions")
      return route.fulfill({
        json: [
          { id: "steps", model: "gpt-6-sol", title: "Run tests", repository: "", updatedAt: 1 },
        ],
      });

    if (new URL(route.request().url()).pathname === "/api/auth")
      return route.fulfill({ json: signedIn });

    return route.fulfill({ json: { state: "connected" } });
  });

  const prompt = {
    id: 1,
    kind: "pi.user",
    model: [{ role: "user", content: "Run tests", timestamp: Date.now() - 5000 }],
  };

  const call = (id: string, command: string) => ({
    type: "toolCall",
    id,
    name: "bash",
    arguments: { command },
  });

  const result = (id: string, text: string) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
  });

  let push: (entries: unknown[], live: typeof Live.Type) => void = () => {};

  await page.routeWebSocket("**/api/sessions/steps/events", (socket) => {
    push = (entries, live) =>
      socket.send(JSON.stringify({ entries: [prompt, ...entries], docs: { "pi.live": live } }));
    // The first tool call is still streaming, so it only exists in the live message.
    push([], {
      run: {},
      generation: { message: { role: "assistant", content: [call("call-1", "pnpm lint")] } },
      tools: [{ callId: "call-1", name: "bash", status: "running", output: "Linting" }],
    });
  });
  await page.goto("/", { waitUntil: "networkidle" });

  const group = page.locator("details.step-group");
  const steps = page.locator("details.step");
  await expect(group.locator("> summary")).toContainText("1 step");
  // Step groups start collapsed, even while their first step is running.
  await expect(group).toHaveJSProperty("open", false);
  await group.locator("> summary").click();
  await expect(group).toHaveJSProperty("open", true);
  await expect(steps.first().locator("> summary")).toContainText("pnpm lint");
  // Steps are one-line rows until the user opens one.
  await expect(steps.first()).toHaveJSProperty("open", false);
  await steps.first().locator("> summary").click();
  await expect(steps.first()).toHaveJSProperty("open", true);
  await expect(page.getByText("Linting")).toBeVisible();

  // A flash is a close (then a reopen), or a remount that replaces the element.
  // Record every close from here on so one can't slip between assertions, and
  // tag the group's element so a replacement shows up.
  await page.evaluate(() => {
    document.body.dataset.closed = "";
    document.addEventListener(
      "toggle",
      (event) => {
        if (event.target instanceof HTMLDetailsElement && !event.target.open)
          document.body.dataset.closed += `${event.target.className} `;
      },
      true,
    );
  });
  await group.evaluate((element) => element.setAttribute("data-original", ""));

  const first = {
    id: 2,
    kind: "pi.message",
    model: [
      { role: "assistant", content: [call("call-1", "pnpm lint")] },
      result("call-1", "Lint clean"),
    ],
  };

  // The live message is saved and the tool finishes; the model is thinking
  // about the next call, so nothing is running for a moment.
  push([first], { run: {}, generation: { message: { role: "assistant", content: [] } } });
  await expect(page.getByText("Lint clean")).toBeVisible();
  // The next tool joins the same group.
  push([first], {
    run: {},
    generation: { message: { role: "assistant", content: [call("call-2", "pnpm test")] } },
    tools: [{ callId: "call-2", name: "bash", status: "running", output: "Testing" }],
  });
  await expect(steps.nth(1).locator("> summary")).toContainText("pnpm test");
  await expect(group).toHaveCount(1);
  await expect(group).toHaveJSProperty("open", true);
  await expect(steps).toHaveCount(2);
  // The step the user opened stays open; the new one starts collapsed.
  await expect(steps.nth(0)).toHaveJSProperty("open", true);
  await expect(steps.nth(1)).toHaveJSProperty("open", false);

  // Nothing opened or closed on its own while the agent worked.
  const body = page.locator("body");
  await expect(body).toHaveAttribute("data-closed", "");
  await expect(group).toHaveAttribute("data-original", "");

  // Closing the group is the user's choice and survives further progress.
  await group.locator("> summary").click();
  await expect(group).toHaveJSProperty("open", false);

  const second = {
    id: 3,
    kind: "pi.message",
    model: [
      { role: "assistant", content: [call("call-2", "pnpm test")] },
      result("call-2", "Tests passed"),
    ],
  };

  push([first, second], { run: {}, generation: { message: { role: "assistant", content: [] } } });
  push([first, second], {
    run: {},
    generation: { message: { role: "assistant", content: [call("call-3", "pnpm build")] } },
    tools: [{ callId: "call-3", name: "bash", status: "running", output: "Building" }],
  });
  await expect(group.locator("> summary")).toContainText("3 steps");
  await expect(group).toHaveJSProperty("open", false);
  await expect(body).toHaveAttribute("data-closed", "step-group ");
  await expect(group).toHaveAttribute("data-original", "");
});

const pastedLog = [
  "can we fix?",
  "",
  "# AnalyticsSQLAPIError",
  "",
  'Query invalid: query must include a time range (e.g., request `time_range.start: "2026-01-01T00:00:00Z"`)',
  "",
  "## Request",
  "",
  "```",
  "GET /api/providers/p2w1yvPwXadv/activity-summary?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z&granularity=hour",
  "```",
  "",
  "## Stack",
  "",
  "```",
  'AnalyticsSQLAPIError: Query invalid: query must include a time range (e.g., request `time_range.start: "2026-01-01T00:00:00Z"`)',
  "    at runAnalyticsQuery (src/analytics/sql.ts:88:11)",
  "```",
].join("\n");

for (const width of [1440, 390]) {
  test(`keeps a pasted markdown prompt with long code lines inside the conversation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;

      if (path === "/api/auth") return route.fulfill({ json: signedIn });

      if (path === "/api/sessions")
        return route.fulfill({
          json: [
            {
              id: "pasted",
              model: "gpt-6-sol",
              title: "can we fix? # AnalyticsSQLAPIError",
              repository: "octocat/project",
              updatedAt: 1,
            },
          ],
        });

      if (path === "/api/sessions/pasted")
        return route.fulfill({
          json: {
            conversation: { id: 1 },
            entries: [
              {
                id: 1,
                kind: "pi.user",
                model: [{ role: "user", content: pastedLog, timestamp: Date.now() - 5000 }],
              },
            ],
            docs: {},
          },
        });

      return route.fulfill({ json: { state: "connected" } });
    });
    await page.goto("/", { waitUntil: "networkidle" });
    const prompt = page.getByRole("article", { name: "user message" });

    await expect(prompt).toContainText("AnalyticsSQLAPIError");

    // The bubble must not grow past the transcript column: long code lines scroll inside it.
    const overflow = await prompt.evaluate((element) => {
      const column = element.closest(".conversation-content")!.getBoundingClientRect();
      const bubble = element.querySelector(".prompt-bubble")!.getBoundingClientRect();

      return { left: bubble.left - column.left, right: column.right - bubble.right };
    });

    expect(overflow.left).toBeGreaterThanOrEqual(0);
    expect(overflow.right).toBeGreaterThanOrEqual(0);
  });
}
