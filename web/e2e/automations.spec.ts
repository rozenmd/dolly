import * as Schema from "effect/Schema";
import { expect, test } from "./browser";

const auth = {
  github: {
    connected: true,
    owner: "octocat",
    appSlug: "dolly-test",
    installUrl: "https://github.com/apps/dolly-test/installations/new",
    settingsUrl: "https://github.com/settings/apps/dolly-test",
    ingress: null,
    senders: ["octocat"],
    reviews: false,
  },
  ownerClaimed: true,
  user: { login: "octocat" },
};

type Run = {
  trigger: "schedule" | "manual";
  at: number;
  status: "running" | "succeeded" | "failed" | "skipped";
  sessionId?: string;
  summary?: string;
  error?: string;
};

type Automation = {
  id: string;
  name: string;
  prompt: string;
  schedule?: string;
  timeZone?: string;
  runAt?: number;
  enabled: boolean;
  readOnly: boolean;
  workspace?: { repository: string; ref?: string; networkHosts?: readonly string[] };
  model?: string;
  mcpServers: string[];
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  runs: Run[];
};

const Body = Schema.Struct({
  name: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  schedule: Schema.optional(Schema.NullOr(Schema.String)),
  timeZone: Schema.optional(Schema.NullOr(Schema.String)),
  runAt: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  mcpServers: Schema.optional(Schema.Array(Schema.String)),
  workspace: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        repository: Schema.String,
        ref: Schema.optional(Schema.String),
        // Decoded so a request that sent hosts would show them, not have them stripped.
        networkHosts: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  accessWas: Schema.optional(
    Schema.Struct({
      readOnly: Schema.Boolean,
      mcpServers: Schema.Array(Schema.String),
      repository: Schema.NullOr(Schema.String),
      ref: Schema.NullOr(Schema.String),
    }),
  ),
});

test("creates, runs, pauses and deletes an automation, and marks its sessions in the sidebar", async ({
  page,
}) => {
  const now = Date.now();

  let automations: Automation[] = [
    {
      id: "a1",
      name: "Stale PR monitor",
      prompt: "List the stale pull requests.",
      schedule: "0 9 * * 1-5",
      timeZone: "Europe/Paris",
      enabled: true,
      readOnly: true,
      workspace: { repository: "octocat/project" },
      mcpServers: [],
      createdAt: now,
      updatedAt: now,
      nextRunAt: now + 3_600_000,
      runs: [
        {
          trigger: "schedule",
          at: now - 7_200_000,
          status: "failed",
          sessionId: "41",
          error: "Model refused",
        },
      ],
    },
  ];

  const created: (typeof Body.Type)[] = [];
  const updated: (typeof Body.Type)[] = [];
  const runs: string[] = [];
  const deleted: string[] = [];

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/sessions")
      return route.fulfill({
        json: [
          {
            id: "41",
            title: "Stale PR monitor",
            model: "gpt-6-luna",
            repository: "octocat/project",
            updatedAt: now,
            archived: false,
            automationRun: { id: "a1", name: "Stale PR monitor" },
          },
          {
            id: "40",
            title: "Fix the flaky test",
            model: "gpt-6-luna",
            repository: "octocat/project",
            updatedAt: now - 1000,
            archived: false,
          },
        ],
      });

    if (path === "/api/connections")
      return route.fulfill({
        json: {
          mcpServers: [
            {
              name: "linear",
              transport: "http",
              target: "https://mcp.linear.app/mcp",
              headerKeys: [],
              status: "connected",
            },
          ],
        },
      });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({
        json: {
          repositories: [
            {
              fullName: "octocat/project",
              defaultBranch: "main",
              private: true,
              description: null,
              registered: true,
            },
          ],
        },
      });

    if (path === "/api/automations" && method === "GET")
      return route.fulfill({ json: { automations } });

    if (path === "/api/automations" && method === "POST") {
      const body = Schema.decodeUnknownSync(Body)(route.request().postDataJSON());

      created.push(body);

      const automation: Automation = {
        id: "a2",
        name: body.name ?? "",
        prompt: body.prompt ?? "",
        schedule: body.schedule ?? undefined,
        timeZone: body.timeZone ?? undefined,
        enabled: body.enabled ?? true,
        readOnly: body.readOnly ?? false,
        workspace: body.workspace ?? undefined,
        mcpServers: [...(body.mcpServers ?? [])],
        createdAt: now,
        updatedAt: now,
        nextRunAt: now + 7_200_000,
        runs: [],
      };

      automations = [...automations, automation];

      return route.fulfill({ status: 201, json: automation });
    }

    const run = /^\/api\/automations\/([^/]+)\/run$/.exec(path);

    if (run && method === "POST") {
      runs.push(run[1]);
      automations = automations.map((item) =>
        item.id === run[1]
          ? {
              ...item,
              runs: [
                { trigger: "manual", at: Date.now(), status: "running", sessionId: "42" },
                ...item.runs,
              ],
            }
          : item,
      );

      return route.fulfill({ status: 202, json: { sessionId: "42" } });
    }

    const one = /^\/api\/automations\/([^/]+)$/.exec(path);

    if (one && method === "PUT") {
      const body = Schema.decodeUnknownSync(Body)(route.request().postDataJSON());

      updated.push(body);
      automations = automations.map((item) =>
        item.id === one[1] ? { ...item, enabled: body.enabled ?? item.enabled } : item,
      );

      return route.fulfill({ json: automations.find((item) => item.id === one[1]) });
    }

    if (one && method === "DELETE") {
      deleted.push(one[1]);
      automations = automations.filter((item) => item.id !== one[1]);

      return route.fulfill({ json: { ok: true } });
    }

    return route.fulfill({ json: { state: "connected" } });
  });

  // The sidebar marks sessions an automation started and links to the page.
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("img", { name: "Started by automation Stale PR monitor" }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /Started by automation/ })).toHaveCount(1);
  await page.getByRole("link", { name: "Automations" }).click();

  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
  await expect(page.getByText("Weekdays at 09:00 (Europe/Paris)")).toBeVisible();
  await expect(page.getByText("Read-only")).toBeVisible();
  await expect(page.getByText("Recent runs (1)")).toBeVisible();

  // Run history links to each run's session.
  await page.getByText("Recent runs (1)").click();
  await expect(page.getByText("Model refused")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open session" })).toBeVisible();

  // Create a scheduled automation with a repository and one MCP server.
  await page.getByRole("button", { name: "New automation" }).click();
  await page.getByLabel("Name").fill("Nightly dependency check");
  await page.getByLabel("Prompt").fill("Update outdated dependencies and open a pull request.");
  await page.getByLabel("Cron expression").fill("30 2 * * *");
  await page.getByLabel("Time zone").fill("UTC");
  await page.getByRole("button", { name: "Repository" }).click();
  await page.getByRole("option", { name: /project/ }).click();
  await page.getByLabel("Linear").click();
  await page.getByRole("button", { name: "Create automation" }).click();

  await expect(page.getByText("Nightly dependency check")).toBeVisible();
  await expect(page.getByText("Every day at 02:30 (UTC)")).toBeVisible();

  expect(created).toEqual([
    {
      name: "Nightly dependency check",
      prompt: "Update outdated dependencies and open a pull request.",
      enabled: true,
      readOnly: false,
      model: null,
      mcpServers: ["linear"],
      schedule: "30 2 * * *",
      timeZone: "UTC",
      runAt: null,
      workspace: { repository: "octocat/project", ref: "main" },
    },
  ]);

  // Run now starts a run; the button waits for it to finish.
  await page.getByRole("button", { name: "Run now" }).first().click();
  await expect(page.getByRole("button", { name: "Running" })).toBeVisible();
  expect(runs).toEqual(["a1"]);

  // Pause from the row menu.
  await page.getByRole("button", { name: "Manage Nightly dependency check" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(page.getByText("Paused")).toBeVisible();
  expect(updated).toEqual([{ enabled: false }]);

  // Delete after confirming.
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page.getByRole("button", { name: "Manage Nightly dependency check" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByText("Nightly dependency check")).toHaveCount(0);
  expect(deleted).toEqual(["a2"]);
});

test("refuses to save while required fields are empty and shows server errors", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/automations" && method === "GET")
      return route.fulfill({ json: { automations: [] } });

    if (path === "/api/automations" && method === "POST")
      return route.fulfill({
        status: 400,
        json: { error: "Schedules can run at most every 10 minutes" },
      });

    if (path === "/api/connections") return route.fulfill({ json: { mcpServers: [] } });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    return route.fulfill({ json: [] });
  });

  await page.goto("/settings/automations", { waitUntil: "networkidle" });
  await expect(page.getByText(/No automations yet/)).toBeVisible();

  await page.getByRole("button", { name: "New automation" }).click();
  await expect(page.getByRole("button", { name: "Create automation" })).toBeDisabled();
  await expect(page.getByText("No MCP servers connected. Add them in Connections.")).toBeVisible();

  await page.getByLabel("Name").fill("Too often");
  await page.getByLabel("Prompt").fill("Ping");
  await page.getByLabel("Cron expression").fill("* * * * *");
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByRole("alert")).toHaveText("Schedules can run at most every 10 minutes");

  // Cancel closes the form without saving.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Name")).toHaveCount(0);
});

test("edits send only what changed, so they never undo a pause or move a schedule", async ({
  page,
}) => {
  const now = Date.now();

  let automations: Automation[] = [
    {
      id: "a1",
      name: "Morning check",
      prompt: "Check the deploys.",
      // Created through the API without a zone: it runs in UTC.
      schedule: "0 9 * * *",
      enabled: true,
      readOnly: false,
      workspace: {
        repository: "octocat/project",
        ref: "develop",
        networkHosts: ["staging.example.com"],
      },
      mcpServers: [],
      createdAt: now,
      updatedAt: now,
      nextRunAt: now + 3_600_000,
      runs: [],
    },
    {
      id: "a2",
      name: "Reminder",
      prompt: "Look at the deploy.",
      runAt: now - 3_600_000,
      enabled: true,
      readOnly: false,
      mcpServers: [],
      createdAt: now,
      updatedAt: now,
      runs: [{ trigger: "schedule", at: now - 3_600_000, status: "succeeded", sessionId: "43" }],
    },
    {
      id: "a3",
      name: "Long audit",
      prompt: "Audit everything.",
      schedule: "*/10 * * * *",
      timeZone: "UTC",
      enabled: true,
      readOnly: false,
      mcpServers: [],
      createdAt: now,
      updatedAt: now,
      runs: [
        { trigger: "schedule", at: now - 60_000, status: "skipped", error: "Still running" },
        { trigger: "manual", at: now - 900_000, status: "running", sessionId: "44" },
      ],
    },
  ];

  const updated: { id: string; body: typeof Body.Type }[] = [];

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/automations" && method === "GET")
      return route.fulfill({ json: { automations } });

    if (path === "/api/connections") return route.fulfill({ json: { mcpServers: [] } });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({
        json: {
          repositories: ["project", "other"].map((name) => ({
            fullName: `octocat/${name}`,
            defaultBranch: "main",
            private: true,
            description: null,
            registered: true,
          })),
        },
      });

    const one = /^\/api\/automations\/([^/]+)$/.exec(path);

    if (one && method === "PUT") {
      const body = Schema.decodeUnknownSync(Body)(route.request().postDataJSON());

      updated.push({ id: one[1], body });
      automations = automations.map((item) =>
        item.id === one[1]
          ? { ...item, name: body.name ?? item.name, enabled: body.enabled ?? item.enabled }
          : item,
      );

      return route.fulfill({ json: automations.find((item) => item.id === one[1]) });
    }

    return route.fulfill({ json: [] });
  });

  await page.goto("/settings/automations", { waitUntil: "networkidle" });

  // A skipped fire newer than the live run doesn't offer another run.
  await expect(page.getByRole("button", { name: "Running" })).toBeDisabled();

  // The form shows the UTC the schedule runs in, not the browser's zone.
  await page.getByRole("button", { name: "Manage Morning check" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByLabel("Time zone")).toHaveValue("UTC");

  // Paused from the list while the form is open: saving a rename keeps it paused.
  await page.getByRole("button", { name: "Manage Morning check" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(page.getByText("Paused")).toBeVisible();

  // Another repository and back again: its own branch, so the workspace isn't sent.
  await page.getByRole("button", { name: "Repository" }).click();
  await page.getByRole("option", { name: /other/ }).click();
  await page.getByRole("button", { name: "Repository" }).click();
  await page.getByRole("option", { name: /project/ }).click();

  await page.getByLabel("Name").fill("Deploy check");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Deploy check")).toBeVisible();
  await expect(page.getByText("Paused")).toBeVisible();

  expect(updated).toEqual([
    { id: "a1", body: { enabled: false } },
    { id: "a1", body: { name: "Deploy check" } },
  ]);

  // Moving it to another repository sends its access whole, as shown: the read-only setting and
  // MCP servers go with the repository, so an edit made elsewhere can't change what runs may do.
  await page.getByRole("button", { name: "Manage Deploy check" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Repository" }).click();
  await page.getByRole("option", { name: /other/ }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => updated.length).toBe(3);
  expect(updated[2]).toEqual({
    id: "a1",
    body: {
      readOnly: false,
      mcpServers: [],
      workspace: { repository: "octocat/other", ref: "main" },
      // The access it was opened with: the server refuses the edit if that changed since.
      accessWas: {
        readOnly: false,
        mcpServers: [],
        repository: "octocat/project",
        ref: "develop",
      },
    },
  });

  // An access edit on the same repository never sends network hosts: the form doesn't edit
  // them, and resending its copy could restore hosts revoked since it opened.
  await page.getByRole("button", { name: "Manage Deploy check" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel(/Read-only/).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => updated.length).toBe(4);
  expect(updated[3]).toEqual({
    id: "a1",
    body: {
      readOnly: true,
      mcpServers: [],
      workspace: { repository: "octocat/project", ref: "develop" },
      accessWas: {
        readOnly: false,
        mcpServers: [],
        repository: "octocat/project",
        ref: "develop",
      },
    },
  });

  // A one-off that already ran can be renamed without picking a new time.
  await page.getByRole("button", { name: "Manage Reminder" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("Deploy reminder");

  // Clearing its time asks for one, and leaves the form usable.
  // Typing can't empty a date field; set it as the browser does when it is cleared.
  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>("#automation-at");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

    if (!field || !setter) throw new Error("Run at field missing");
    setter.call(field, "");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Choose a date and time to run it at.");
  await expect(page.getByRole("button", { name: "Cancel" })).not.toBeDisabled();
  expect(updated).toHaveLength(4);

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Manage Reminder" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("Deploy reminder");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Deploy reminder")).toBeVisible();
  expect(updated.at(-1)).toEqual({ id: "a2", body: { name: "Deploy reminder" } });
});
