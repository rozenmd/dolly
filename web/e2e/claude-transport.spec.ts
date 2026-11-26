import * as Schema from "effect/Schema";
import { expect, test } from "./browser";

const github = {
  connected: true,
  owner: "octocat",
  appSlug: "dolly-test",
  installUrl: "https://github.com/apps/dolly-test/installations/new",
  settingsUrl: "https://github.com/settings/apps/dolly-test",
  ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  senders: ["octocat"],
};

const TransportChange = Schema.Struct({ transport: Schema.Literals(["direct", "claude-code"]) });

test("switches Claude requests between the Worker and the real Claude Code", async ({ page }) => {
  let transport = "direct";
  const saved: string[] = [];

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github, ownerClaimed: true, user: { login: "octocat" } } });

    if (path === "/api/auth/anthropic")
      return route.fulfill({ json: { connected: true, transport } });

    if (path === "/api/auth/anthropic/transport" && method === "PUT") {
      transport = Schema.decodeUnknownSync(TransportChange)(
        route.request().postDataJSON(),
      ).transport;
      saved.push(transport);

      return route.fulfill({ json: { transport } });
    }

    if (path === "/api/auth/chatgpt") return route.fulfill({ json: { state: "connected" } });

    if (path === "/api/settings/model")
      return route.fulfill({
        json: {
          model: null,
          effective: "claude-sonnet-5-5",
          thinkingLevel: "high",
          speed: "standard",
          autoFallback: true,
          ultrafastAvailable: false,
        },
      });

    if (path === "/api/usage") return route.fulfill({ json: { providers: [] } });

    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });

  await page.goto("/settings/models", { waitUntil: "networkidle" });

  const picker = page.getByRole("button", { name: /Claude requests/ });
  await expect(picker).toHaveText("Direct");
  await expect(page.getByText("Sent by the Worker, presented as Claude Code")).toBeVisible();

  await picker.click();
  await page.getByRole("option", { name: /^Claude Code/ }).click();

  await expect(picker).toHaveText("Claude Code");
  await expect(page.getByText("Sent by the real Claude Code, in its own container")).toBeVisible();
  expect(saved).toEqual(["claude-code"]);

  // The saved choice is what the page shows after a reload.
  await page.goto("/settings/models", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: /Claude requests/ })).toHaveText("Claude Code");
});
