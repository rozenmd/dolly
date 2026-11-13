import type { ChatMessage } from "./api";

export const previewSessions = [
  {
    id: "presence",
    title: "Add multiplayer workspace presence",
    repository: "pi-hard",
    status: "Complete",
    time: "22m",
  },
  {
    id: "checkout",
    title: "Review checkout recovery",
    repository: "storefront",
    status: "Working",
    time: "2m",
  },
  {
    id: "mobile",
    title: "Improve mobile navigation",
    repository: "pi-hard",
    status: "Unread",
    time: "8m",
  },
  {
    id: "shortcuts",
    title: "Ship keyboard shortcuts",
    repository: "pi-hard",
    status: "Complete",
    time: "34m",
  },
  {
    id: "search",
    title: "Make session search instant",
    repository: "pi-hard",
    status: "Working",
    time: "5m",
  },
  {
    id: "notes",
    title: "Draft the weekly release notes",
    repository: "pi-hard",
    status: "Idle",
    time: "1h",
  },
  {
    id: "import",
    title: "Import contacts from a CSV",
    repository: "dashboard",
    status: "Idle",
    time: "2h",
  },
  {
    id: "billing",
    title: "Retry failed billing webhooks",
    repository: "storefront",
    status: "Idle",
    time: "3h",
  },
  {
    id: "onboarding",
    title: "Rewrite the onboarding empty state",
    repository: "dashboard",
    status: "Idle",
    time: "3h",
  },
  {
    id: "tests",
    title: "Track down the flaky end-to-end test",
    repository: "pi-hard",
    status: "Idle",
    time: "4h",
  },
  {
    id: "audit",
    title: "Add an audit log to settings",
    repository: "dashboard",
    status: "Idle",
    time: "5h",
  },
  {
    id: "uploads",
    title: "Speed up image uploads",
    repository: "storefront",
    status: "Idle",
    time: "1d",
  },
];

export const previewMessages: ChatMessage[] = [
  {
    id: "p1",
    role: "user",
    text: "Add multiplayer presence to project workspaces. Have a focused agent cover the tests, then open a pull request.",
  },
  {
    id: "p2",
    role: "user",
    text: "Overlap the faces when more than one person is in the same workspace.",
  },
  {
    id: "p3",
    role: "assistant",
    text: "Presence now appears in every shared workspace, and the pull request is ready.\n\n- **Sidebar** rolls each session’s viewers into the workspace row, deduplicated by user.\n- **Faces overlap** with a ring in the row’s colour, so a stack stays legible.\n- **Tests cover** the roll-up and the self-suppression rule.\n\nThe implementation and test coverage are ready for review.",
  },
];
