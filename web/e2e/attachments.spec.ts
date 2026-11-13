import { Buffer } from "node:buffer";
import { expect, test } from "@playwright/test";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

type Prompt = { content: string; requestId: string; images?: { mimeType: string; data: string }[] };

test("attaches screenshots in both composers with picker, paste and drop, and preserves retry IDs", async ({
  page,
}) => {
  const sent: Prompt[] = [];
  const accepted: Prompt[] = [];
  const failures = new Set<string>();

  await page.routeWebSocket("**/api/sessions/*/events", (socket) => {
    socket.send(JSON.stringify({ entries: [], docs: {} }));
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({
        json: {
          ownerClaimed: true,
          user: { login: "octocat" },
          github: {
            connected: true,
            owner: "octocat",
            appSlug: "dolly-test",
            installUrl: "https://github.com/apps/dolly-test/installations/new",
            settingsUrl: "https://github.com/settings/apps/dolly-test",
            ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
            senders: ["octocat"],
          },
        },
      });

    if (path === "/api/auth/codex") return route.fulfill({ json: { state: "connected" } });

    if (path === "/api/auth/anthropic") return route.fulfill({ json: { connected: false } });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    if (path === "/api/sessions")
      return route.fulfill({ status: 201, json: { id: "screenshots", model: "gpt-6-luna" } });

    if (path === "/api/sessions/screenshots/messages") {
      const prompt: Prompt = route.request().postDataJSON();
      sent.push(prompt);

      if (prompt.content !== "Initial screenshot" && !failures.has(prompt.content)) {
        failures.add(prompt.content);

        return route.fulfill({ status: 502, json: { error: "Please retry" } });
      }

      accepted.push(prompt);

      return route.fulfill({ status: 202, json: {} });
    }

    if (path === "/api/sessions/screenshots")
      return route.fulfill({
        json: {
          entries: accepted.map((prompt, index) => ({
            id: index + 1,
            kind: "pi.user",
            model: [{ role: "user", content: prompt.content }],
          })),
          docs: {},
        },
      });

    return route.fulfill({ json: {} });
  });

  await page.goto("/", { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.getByLabel("Task", { exact: true }).fill("Initial screenshot");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "initial.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect(dialog.getByRole("img", { name: "initial.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(sent[0].images).toEqual([{ mimeType: "image/png", data: png }]);

  const composer = page.locator("form.composer");
  const prompt = page.getByRole("textbox", { name: "Message your agent" });
  await prompt.evaluate((element, data) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], "pasted.png", {
        type: "image/png",
      }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
    );
  }, png);
  await expect(composer.getByRole("img", { name: "pasted.png" })).toBeVisible();
  await composer.getByRole("button", { name: "Remove pasted.png" }).click();
  await expect(composer.getByRole("img")).toHaveCount(0);
  await composer.evaluate((element, data) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], "dropped.png", {
        type: "image/png",
      }),
    );
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, png);
  await expect(composer.getByRole("img", { name: "dropped.png" })).toBeVisible();

  for (const content of ["Screenshot follow-up", "Text-only follow-up"]) {
    await prompt.fill(content);
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Please retry", { exact: true })).toBeVisible();
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(prompt).toHaveValue("");
    await expect(composer.getByRole("img")).toHaveCount(0);
    const attempts = sent.filter((item) => item.content === content);

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  }

  expect(sent[1].images).toEqual([{ mimeType: "image/png", data: png }]);
  expect(sent[3].images).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("dolly.sessions.v1"))).not.toContain(png);
});
