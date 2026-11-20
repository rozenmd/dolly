import * as Schema from "effect/Schema";
import { expect, test } from "./browser";

const MembersUpdate = Schema.Struct({
  members: Schema.Array(Schema.Struct({ slackId: Schema.String, github: Schema.String })),
});

const github = {
  connected: true,
  owner: "octocat",
  appSlug: "dolly-test",
  installUrl: "https://github.com/apps/dolly-test/installations/new",
  settingsUrl: "https://github.com/settings/apps/dolly-test",
  ingress: "https://dolly-ingress.example.workers.dev/hooks/github",
  senders: ["octocat", "monalisa"],
  reviews: false,
};

const slack = {
  configured: true,
  enabled: true,
  defaultRepository: null,
  teamName: "Example Co",
  eventsUrl: "https://dolly-ingress.example.workers.dev/slack/events",
  actionsUrl: "https://dolly-ingress.example.workers.dev/slack/actions",
  createAppUrl: "https://api.slack.com/apps?new_app=1",
  manifest: "{}",
};

test("maps approved GitHub users and new teammates to Slack member IDs", async ({ page }) => {
  let members: typeof MembersUpdate.Type.members = [{ slackId: "U012ABCDEF", github: "octocat" }];
  const saves: unknown[] = [];

  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/api/auth")
      return route.fulfill({
        json: { github, ownerClaimed: true, user: { login: "octocat" } },
      });

    if (path === "/api/integrations/slack") return route.fulfill({ json: { ...slack, members } });

    if (path === "/api/integrations/slack/members" && route.request().method() === "PUT") {
      const body = Schema.decodeUnknownSync(MembersUpdate)(route.request().postDataJSON());
      saves.push(body);
      members = body.members;

      return route.fulfill({ json: { members } });
    }

    return route.fulfill({ status: 404, json: { error: "unexpected" } });
  });
  await page.goto("/settings/slack", { waitUntil: "networkidle" });

  const teammates = page.getByRole("region", { name: "Teammates" });
  // Everyone approved for /dolly commands is listed, with or without a Slack member ID.
  await expect(teammates.getByRole("listitem")).toHaveCount(2);
  await expect(teammates.getByText("Slack U012ABCDEF")).toBeVisible();
  await expect(teammates.getByText("No Slack member ID")).toBeVisible();

  await teammates.getByRole("button", { name: "Edit monalisa" }).click();
  const dialog = page.getByRole("dialog", { name: "Slack ID for @monalisa" });
  await expect(dialog.getByLabel("GitHub login")).toHaveValue("monalisa");
  await dialog.getByLabel("Slack member ID").fill("u034ghijkl");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(teammates.getByText("Slack U034GHIJKL")).toBeVisible();
  expect(saves.at(-1)).toEqual({
    members: [
      { slackId: "U012ABCDEF", github: "octocat" },
      { slackId: "U034GHIJKL", github: "monalisa" },
    ],
  });

  // A teammate who cannot run /dolly commands can still be added for Slack.
  await teammates.getByRole("button", { name: "Add teammate" }).click();
  const add = page.getByRole("dialog", { name: "Add teammate" });
  await add.getByLabel("GitHub login").fill("@hubot");
  await add.getByLabel("Slack member ID").fill("U056MNOPQR");
  await add.getByRole("button", { name: "Save" }).click();
  await expect(teammates.getByRole("listitem")).toHaveCount(3);
  expect(saves.at(-1)).toEqual({
    members: [
      { slackId: "U012ABCDEF", github: "octocat" },
      { slackId: "U034GHIJKL", github: "monalisa" },
      { slackId: "U056MNOPQR", github: "hubot" },
    ],
  });

  // Removing an approved user's Slack ID keeps them listed without one.
  await teammates.getByRole("button", { name: "Remove octocat from Slack" }).click();
  await expect(teammates.getByText("Slack U012ABCDEF")).toHaveCount(0);
  await expect(teammates.getByRole("listitem")).toHaveCount(3);
  expect(saves.at(-1)).toEqual({
    members: [
      { slackId: "U034GHIJKL", github: "monalisa" },
      { slackId: "U056MNOPQR", github: "hubot" },
    ],
  });
});
