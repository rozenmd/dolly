import { REVIEW_INSTRUCTIONS } from "../../../src/review-instructions";

/**
 * Starting points for Settings > Automations, after OpenSession's automation templates. Picking
 * one fills the new-automation form; every field stays editable before saving. Prompts are
 * self-contained, because each run is a fresh session that remembers nothing of earlier runs.
 * Adding a recipe is data only. A recipe may only rely on what a run can actually reach: its
 * checkout (git history included), package registries, and the MCP servers it lists. The GitHub
 * tool can't list open pull requests, issues or CI runs, so no recipe may need those lists.
 */
export type AutomationRecipe = {
  id: string;
  name: string;
  /** One line for the picker. */
  description: string;
  /** Five-field cron, read in the owner's time zone. */
  schedule?: string;
  /** Runs for each pull request instead of on a schedule (src/automations.ts). */
  event?: "pull_request";
  /** Runs only read and report; needs a repository (an event's pipeline picks its own). */
  readOnly: boolean;
  /** MCP servers the prompt uses, ticked only when connected. */
  mcpServers: readonly string[];
  prompt: string;
};

export const AUTOMATION_RECIPES: readonly AutomationRecipe[] = [
  {
    // After OpenSession's `github-pr-review` recipe, the one most workflows hang off.
    id: "pull-request-review",
    name: "Review pull requests",
    description: "Reviews each pull request when it opens and on every push, with inline comments.",
    event: "pull_request",
    readOnly: true,
    mcpServers: [],
    prompt: REVIEW_INSTRUCTIONS,
  },
  {
    id: "weekly-changelog",
    name: "Weekly changelog draft",
    description: "Friday draft of the week's user-facing changes.",
    schedule: "0 14 * * 5",
    readOnly: true,
    mcpServers: [],
    prompt: `Draft a user-facing changelog for this week from the repository's history. Your checkout is shallow (only the latest commit), so first fetch the week's history of the default branch, for example \`git fetch --shallow-since="8 days ago" origin <default branch>\`, then read \`git log --since="7 days ago" FETCH_HEAD\`. If you still can't see a week of history, say so rather than drafting from part of it.

Merged pull requests show up as merge or squash commits, usually ending in their number, like "(#123)". Leave out internal-only changes (refactors, CI, tooling) unless users would notice them, such as performance or reliability.

Features first, then improvements, then fixes; one line each, written for users rather than engineers, with the pull request number when there is one. Flag anything you are unsure is user-visible.`,
  },
  {
    id: "dependency-check",
    name: "Dependency update check",
    description: "Weekly pull request bumping dependencies that are safe to bump.",
    schedule: "0 6 * * 2",
    readOnly: false,
    mcpServers: [],
    prompt: `Check this repository's dependencies for updates and known vulnerabilities.

1. List outdated packages and security advisories, using the repository's package manager.
2. Bump only safe updates: patch and minor versions. Never bump a major version, or anything the repository pins on purpose (read comments and the lockfile first).
3. Run the tests and type checks to confirm nothing breaks.
4. Open one pull request with the bumps, listing each package with its old and new version. Note any major or vulnerable packages you did not bump, so a person can decide.

If everything is current, don't open a pull request; say so.`,
  },
  {
    id: "error-sweep",
    name: "Production error sweep",
    description: "Daily triage of new and spiking errors in Sentry.",
    schedule: "30 6 * * *",
    readOnly: false,
    mcpServers: ["sentry"],
    prompt: `Sweep the production errors from the last 24 hours in Sentry.

1. List the top new and escalating issues. For each: users affected, when it started, and a one-line hypothesis from the stack trace.
2. Rank them by user impact. For the top one to three, find the likely code path in this repository and say whether it looks like a regression (compare with recent merges) or a long-standing issue.

Output the ranked list with your notes. Don't attempt fixes in this run; recommend which issues deserve their own session.`,
  },
];
