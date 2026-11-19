// Copyright (c) 2026 Tella. MIT license: third_party/opensession/LICENSE.
// Permission maps from https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/shared/github-app-permissions.ts

export const GITHUB_APP_GRANT_PERMISSIONS = {
  actions: "write",
  checks: "write",
  statuses: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  members: "read",
  deployments: "write",
  metadata: "read",
};

export const GITHUB_APP_READ_PERMISSIONS = {
  actions: "read",
  checks: "read",
  statuses: "read",
  pull_requests: "read",
  contents: "read",
  issues: "read",
  members: "read",
  deployments: "read",
  metadata: "read",
};

export const GITHUB_APP_WRITE_PERMISSIONS = {
  pull_requests: "write",
  issues: "write",
  contents: "write",
  metadata: "read",
};

export const GITHUB_APP_CODE_PERMISSIONS = {
  ...GITHUB_APP_WRITE_PERMISSIONS,
  actions: "read",
  checks: "read",
  statuses: "read",
};

/** Webhook events Dolly subscribes new Apps to: comments start agents, CI events wake waits early. */
export const GITHUB_APP_EVENTS = [
  "issue_comment",
  "check_run",
  "check_suite",
  "status",
  "workflow_run",
  "workflow_job",
  "pull_request",
];

type AccessLevel = "none" | "read" | "write" | "admin";

function level(value: string | undefined): AccessLevel {
  if (value === "admin" || value === "write" || value === "read") return value;

  return "none";
}

const LEVELS: ReadonlyArray<AccessLevel> = ["none", "read", "write", "admin"];

/** What a GitHub App, or one installation of it, grants below what Dolly's manifest asks for. */
export function appGaps(granted: {
  permissions: Readonly<Record<string, string | undefined>>;
  events: ReadonlyArray<string>;
}) {
  return {
    permissions: Object.entries(GITHUB_APP_GRANT_PERMISSIONS)
      .filter(
        ([name, wanted]) =>
          LEVELS.indexOf(level(granted.permissions[name])) < LEVELS.indexOf(level(wanted)),
      )
      .map(([name, wanted]) => `${name}: ${wanted}`),
    events: GITHUB_APP_EVENTS.filter((event) => !granted.events.includes(event)),
  };
}
