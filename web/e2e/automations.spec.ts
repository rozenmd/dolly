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
  webhook: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("rotate")])),
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
  await page.getByLabel("Linear", { exact: true }).click();
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
      webhook: false,
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

  // A recipe fills the form; every field stays editable.
  await page.getByRole("button", { name: "Weekly changelog draft" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Weekly changelog draft");
  await expect(page.getByLabel("Cron expression")).toHaveValue("0 14 * * 5");
  await expect(page.getByLabel("Prompt")).toHaveValue(/git log/);
  await expect(page.getByRole("button", { name: "Weekly changelog draft" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Its prompt is about a repository: it isn't saved without one, or turned writable.
  await page.getByRole("button", { name: "Create automation" }).click();
  await expect(page.getByRole("alert")).toHaveText("Pick the repository this recipe works on.");

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

test("reopening Edit after a refused access edit shows the saved access, never the stale form", async ({
  page,
}) => {
  const now = Date.now();

  let automation: Automation = {
    id: "a1",
    name: "Linear triage",
    prompt: "Triage new issues.",
    enabled: true,
    readOnly: false,
    workspace: { repository: "octocat/project" },
    mcpServers: [],
    createdAt: now,
    updatedAt: now,
    runs: [],
  };

  const saved: (typeof Body.Type)[] = [];

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/automations" && method === "GET")
      return route.fulfill({ json: { automations: [automation] } });

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

    if (path === "/api/automations/a1" && method === "PUT") {
      const body = Schema.decodeUnknownSync(Body)(route.request().postDataJSON());
      const seen = body.accessWas;

      // The server's check: an access edit made against other access than it holds is refused.
      if (
        seen &&
        (seen.readOnly !== automation.readOnly ||
          seen.mcpServers.join() !== automation.mcpServers.join())
      )
        return route.fulfill({
          status: 400,
          json: { error: "Its repository, read-only or MCP servers changed since you opened it." },
        });

      saved.push(body);
      automation = {
        ...automation,
        name: body.name ?? automation.name,
        readOnly: body.readOnly ?? automation.readOnly,
        mcpServers: body.mcpServers ? [...body.mcpServers] : automation.mcpServers,
        updatedAt: automation.updatedAt + 1,
      };

      return route.fulfill({ json: automation });
    }

    return route.fulfill({ json: [] });
  });

  await page.goto("/settings/automations", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Manage Linear triage" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  // Another tab makes it read-only while this form is open.
  automation = { ...automation, readOnly: true, updatedAt: now + 10 };
  await page.getByRole("button", { name: "Refresh automations" }).click();

  await page.getByLabel("Linear", { exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText(/changed since you opened it/);

  // Edit again, without Cancel: the form shows read-only as saved, not this form's values.
  await page.getByRole("button", { name: "Manage Linear triage" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  expect(
    await page
      .getByLabel(/Read-only/)
      .evaluate((element) => element instanceof HTMLInputElement && element.checked),
  ).toBe(true);

  await page.getByLabel("Name").fill("Linear triage (read-only)");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Linear triage (read-only)")).toBeVisible();

  // Only the rename was saved: nothing ever turned read-only off.
  expect(saved).toEqual([{ name: "Linear triage (read-only)" }]);
  expect(automation.readOnly).toBe(true);
});

test("waits for connections before a recipe ticks its MCP servers", async ({ page }) => {
  let release: () => void = () => {};
  const connections = new Promise<void>((resolve) => (release = resolve));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/automations") return route.fulfill({ json: { automations: [] } });

    if (path === "/api/connections") {
      await connections;

      return route.fulfill({
        json: {
          mcpServers: [
            {
              name: "sentry",
              transport: "http",
              target: "https://mcp.sentry.dev/mcp",
              headerKeys: [],
              status: "connected",
            },
          ],
        },
      });
    }

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    return route.fulfill({ json: [] });
  });

  await page.goto("/settings/automations");
  await page.getByRole("button", { name: "New automation" }).click();

  // Still loading: picking it now would save a Sentry sweep without Sentry.
  await expect(page.getByRole("button", { name: "Production error sweep" })).toBeDisabled();

  release();
  await page.getByRole("button", { name: "Production error sweep" }).click();
  await expect(page.getByLabel("Name")).toHaveValue("Production error sweep");
  expect(
    await page
      .getByLabel("Sentry")
      .evaluate((element) => element instanceof HTMLInputElement && element.checked),
  ).toBe(true);
});

test("keeps recipes that need MCP servers off when connections can't be loaded", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/automations") return route.fulfill({ json: { automations: [] } });

    if (path === "/api/connections") return route.fulfill({ status: 503, json: { error: "Down" } });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    return route.fulfill({ json: [] });
  });

  await page.goto("/settings/automations", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New automation" }).click();

  // Unknown isn't "none connected": the Sentry recipe can't be saved without Sentry.
  await expect(page.getByText(/Couldn't load your connections/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Production error sweep" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Weekly changelog draft" })).not.toBeDisabled();
});

test("keeps a recipe off while an MCP server it needs is missing or not connected", async ({
  page,
}) => {
  const lists = [
    [],
    [
      {
        name: "sentry",
        transport: "http",
        target: "https://mcp.sentry.dev/mcp",
        headerKeys: [],
        status: "needs-auth",
      },
    ],
  ];

  let served = 0;

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth") return route.fulfill({ json: auth });

    if (path === "/api/automations") return route.fulfill({ json: { automations: [] } });

    if (path === "/api/connections")
      return route.fulfill({ json: { mcpServers: lists[Math.min(served++, lists.length - 1)] } });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    return route.fulfill({ json: [] });
  });

  await page.goto("/settings/automations", { waitUntil: "networkidle" });

  // Neither listed nor connected: a sweep saved without Sentry could never run it.
  for (const _ of lists) {
    await page.getByRole("button", { name: "New automation" }).click();
    await expect(page.getByText(/need an MCP server you haven't connected/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Production error sweep" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Production error sweep" })).toHaveAttribute(
      "title",
      "Connect sentry in Settings > Connections to use this recipe.",
    );
    await expect(page.getByRole("button", { name: "Weekly changelog draft" })).not.toBeDisabled();
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  expect(served).toBeGreaterThanOrEqual(2);
});

test("shows an automation's webhook URL on the ingress Worker and replaces it", async ({
  page,
}) => {
  const now = Date.now();
  let secret = "first-secret";
  const updates: unknown[] = [];
  let finishRotation: () => void = () => {};
  const rotation = new Promise<void>((resolve) => (finishRotation = resolve));
  // A list request to hold: it answers with what it read when it arrived, after the rotation.
  let holdList: Promise<void> | undefined;
  let finishList: () => void = () => {};

  const automation = () => ({
    id: "a1",
    name: "Triage",
    prompt: "Triage the incoming issue",
    enabled: true,
    readOnly: false,
    mcpServers: [],
    createdAt: now,
    updatedAt: now,
    webhookPath: secret ? `/hooks/automations/a1?secret=${secret}` : undefined,
    runs: [{ trigger: "webhook", at: now - 60_000, status: "succeeded", sessionId: "7" }],
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (path === "/api/auth")
      return route.fulfill({
        json: {
          ...auth,
          github: {
            ...auth.github,
            ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
          },
        },
      });

    if (path === "/api/automations") {
      const listed = automation();
      const held = holdList;

      holdList = undefined;

      if (held) await held;

      return route.fulfill({ json: { automations: [listed] } });
    }

    if (path === "/api/automations/a1" && method === "PUT") {
      const body = Schema.decodeUnknownSync(Body)(route.request().postDataJSON());

      updates.push(body);

      // Held open, as a slow network would, to try a second click while it is in flight.
      if (body.webhook === "rotate") await rotation;

      if (body.webhook === false) secret = "";
      else if (body.webhook === "rotate") secret = "second-secret";
      else if (body.webhook && !secret) secret = "second-secret";

      return route.fulfill({ json: automation() });
    }

    if (path === "/api/connections") return route.fulfill({ json: { mcpServers: [] } });

    if (path === "/api/integrations/github/repositories")
      return route.fulfill({ json: { repositories: [] } });

    return route.fulfill({ json: [] });
  });

  await page.goto("/settings/automations", { waitUntil: "networkidle" });
  await expect(page.getByText("When its webhook is called")).toBeVisible();
  await expect(page.getByText("Webhook", { exact: true })).toBeVisible();
  await page.getByText("Recent runs (1)").click();
  await expect(page.getByText(/by webhook/)).toBeVisible();

  await page.getByRole("button", { name: "Manage Triage" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy webhook URL" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  await expect(page.getByLabel("Webhook URL", { exact: true })).toHaveValue(
    "https://dolly-ingress.example.workers.dev/hooks/automations/a1?secret=first-secret",
  );
  await page.getByRole("button", { name: "New URL" }).click();
  // One rotation at a time: a second could show a URL the other already revoked.
  await expect(page.getByRole("button", { name: "Replacing…" })).toBeDisabled();

  // Closed and reopened mid-rotation: still one rotation, and the new form waits for it.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Manage Triage" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: "Replacing…" })).toBeDisabled();

  // A poll starts mid-rotation, reads the old URL, and answers only after the rotation has.
  holdList = new Promise<void>((resolve) => (finishList = resolve));
  await page.getByRole("button", { name: "Refresh automations" }).click();
  await expect.poll(() => holdList === undefined).toBe(true);
  finishRotation();
  await expect(page.getByLabel("Webhook URL", { exact: true })).toHaveValue(
    "https://dolly-ingress.example.workers.dev/hooks/automations/a1?secret=second-secret",
  );
  finishList();
  // One request: there is never a moment with no working URL.
  expect(updates).toEqual([{ webhook: "rotate" }]);

  // The row menu copies the new URL, not the revoked one the late poll carried.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.copied = text;
        },
      },
    });
  });
  // The reopened form copies the new URL, as the row menu does.
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.copied))
    .toBe("https://dolly-ingress.example.workers.dev/hooks/automations/a1?secret=second-secret");
  await page.evaluate(() => delete document.body.dataset.copied);

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Manage Triage" }).click();
  await page.getByRole("menuitem", { name: "Copy webhook URL" }).click();
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.copied))
    .toBe("https://dolly-ingress.example.workers.dev/hooks/automations/a1?secret=second-secret");
});
