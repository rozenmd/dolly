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

type Server = {
  name: string;
  transport: "http";
  target: string;
  headerKeys: string[];
  status: "connected" | "needs-auth" | "unreachable";
  detail?: string;
};

test("lists MCP servers with status, connects a token server and adds a server with headers", async ({
  page,
}) => {
  const servers: Server[] = [
    {
      name: "linear",
      transport: "http",
      target: "https://mcp.linear.app/mcp",
      headerKeys: [],
      status: "connected",
      detail: "HTTP 401",
    },
    {
      name: "vercel",
      transport: "http",
      target: "https://mcp.vercel.com/",
      headerKeys: [],
      status: "needs-auth",
      detail: "API token required. Connect from this card's menu",
    },
  ];

  const tokens: unknown[] = [];
  const added: unknown[] = [];
  let vercelConnected = false;

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({ json: { github, ownerClaimed: true, user: { login: "octocat" } } });

    if (path === "/api/connections") return route.fulfill({ json: { mcpServers: servers } });

    if (path === "/api/connections/mcp/linear/oauth")
      return route.fulfill({
        json: {
          shared: { connectedBy: "octocat", updatedAt: "2026-01-01T00:00:00Z" },
          users: [],
          manualToken: false,
        },
      });

    if (path === "/api/connections/mcp/vercel/oauth")
      return route.fulfill({
        json: vercelConnected
          ? {
              shared: { connectedBy: "octocat", updatedAt: "2026-01-02T00:00:00Z" },
              users: [],
              manualToken: true,
            }
          : { users: [], manualToken: true },
      });

    if (path === "/api/connections/mcp/vercel/token" && method === "POST") {
      tokens.push(route.request().postDataJSON());
      vercelConnected = true;
      servers[1] = { ...servers[1], status: "connected", detail: "HTTP 401" };

      return route.fulfill({ json: { ok: true } });
    }

    if (path === "/api/connections/mcp" && method === "POST") {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ name: Schema.String, url: Schema.String }),
      )(route.request().postDataJSON());

      added.push(route.request().postDataJSON());
      servers.push({
        name: body.name,
        transport: "http",
        target: body.url,
        headerKeys: ["X-Api-Key"],
        status: "connected",
        detail: "HTTP 405",
      });

      return route.fulfill({ json: { ok: true } });
    }

    if (/^\/api\/connections\/mcp\/[^/]+\/oauth$/.test(path))
      return route.fulfill({ json: { users: [], manualToken: false } });

    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });

  await page.goto("/settings/connections", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("OAuth · workspace")).toBeVisible();
  await expect(page.getByText("Sign in required")).toBeVisible();
  await expect(page.getByText("API token required. Connect from this card's menu")).toBeVisible();

  // An OAuth server offers reconnect, disconnect and remove; a token server offers token connect.
  await page.getByRole("button", { name: "Manage linear" }).click();
  await expect(page.getByRole("menuitem", { name: "Reconnect (workspace)" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Disconnect OAuth" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove server" })).toBeVisible();
  await page.press("Escape");

  await page.getByRole("button", { name: "Manage vercel" }).click();
  await expect(page.getByRole("menuitem", { name: "Connect (workspace)" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Connect with API token" }).click();

  const dialog = page.getByRole("dialog", { name: "Connect Vercel with an API token" });
  await dialog.getByLabel("API token").fill("vercel-token");
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Sign in required")).toHaveCount(0);
  expect(tokens).toEqual([{ token: "vercel-token" }]);
  await expect(page.getByText("Token · workspace")).toBeVisible();

  await page.getByRole("button", { name: "Add MCP server" }).click();
  await expect(page.getByLabel("Transport")).toHaveCount(0);
  await page.getByLabel("URL").fill("https://mcp.linear.app/mcp");
  await expect(page.getByLabel("Name")).toHaveValue("linear");
  await page.getByLabel("Name").fill("internal");
  await page.getByLabel("URL").fill("https://tools.example.com/mcp");
  await expect(page.getByLabel("Name")).toHaveValue("internal");
  await page.getByLabel(/^Headers/).fill("X-Api-Key: secret-value");
  await page.getByRole("button", { name: "Add server" }).click();

  await expect(page.getByRole("listitem")).toHaveCount(3);
  expect(added).toEqual([
    {
      name: "internal",
      transport: "http",
      url: "https://tools.example.com/mcp",
      headers: { "X-Api-Key": "secret-value" },
    },
  ]);
  await expect(page.getByText("Internal")).toBeVisible();
  await expect(page.getByText("secret-value")).toHaveCount(0);
});
