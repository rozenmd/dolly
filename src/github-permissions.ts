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
