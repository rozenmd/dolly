import * as Schema from "effect/Schema";
import { SPEEDS } from "./model-capabilities";

export const SavedSession = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  /** Pi thinking level; absent for sessions saved before it was reported. */
  thinkingLevel: Schema.optional(Schema.String),
  /** Fast and Ultrafast are ChatGPT service tiers (model-capabilities.ts); absent means standard. */
  speed: Schema.optional(Schema.Literals(SPEEDS)),
  /** Switch subscriptions when this one runs out; absent follows the owner's default. */
  autoFallback: Schema.optional(Schema.Boolean),
  /** Coordinator mode is on: the session delegates to child sessions (coordinator.ts). */
  coordinator: Schema.optional(Schema.Boolean),
  title: Schema.String,
  repository: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.optional(Schema.Boolean),
  /**
   * When the owner pinned this session's workspace to the top of the sidebar; absent if not
   * pinned. Pinned workspaces are listed in the order they were pinned.
   */
  pinnedAt: Schema.optional(Schema.Number),
  /**
   * The workspace grouping the sessions about one piece of work. Spawned sessions belong to
   * their root's workspace; sessions from before workspaces were recorded are their own.
   */
  workspaceId: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Number),
  /** The session that spawned this one (Pi's ownership edge); absent for top-level sessions. */
  parentId: Schema.optional(Schema.String),
  /** A spawned session the owner chose to keep in the sidebar. */
  kept: Schema.optional(Schema.Boolean),
  /**
   * What started the session when it wasn't the owner: "review" for an automatic pull request
   * review (a read-only session). The sidebar leaves these out, after OpenSession; they are
   * still reachable by URL, from the review's GitHub links and through the `dolly` tool.
   */
  automation: Schema.optional(Schema.Literal("review")),
  ref: Schema.optional(Schema.String),
  /**
   * The automation whose run started this session (automations.ts); absent otherwise. Unlike
   * reviews, automation runs stay in the sidebar.
   */
  automationRun: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
  /** The agent has live, non-background work in progress. */
  running: Schema.optional(Schema.Boolean),
  /**
   * What a running session is doing now, in one line worded like its transcript step ("Editing
   * checkout.tsx", "Running pnpm test"; tool-activity.ts). Absent unless running.
   */
  activity: Schema.optional(Schema.String),
  /**
   * The latest pull request this session opened. GitHub's state, title and diff
   * size are added when known; the session summary card shows them.
   */
  pullRequest: Schema.optional(
    Schema.Struct({
      repository: Schema.String,
      number: Schema.Number,
      url: Schema.String,
      state: Schema.optional(Schema.Literals(["open", "draft", "merged", "closed"])),
      title: Schema.optional(Schema.String),
      additions: Schema.optional(Schema.Number),
      deletions: Schema.optional(Schema.Number),
      changedFiles: Schema.optional(Schema.Number),
    }),
  ),
});

export type PullRequestState = "open" | "draft" | "merged" | "closed";

/** What one GitHub read of a pull request adds to a session's `pullRequest`. */
export type PullRequestSummary = {
  state: PullRequestState;
  title?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  changedFiles?: number | undefined;
};

export type SavedSession = typeof SavedSession.Type;

/**
 * Owner sidebar choices for one session; at least one must be given. One struct, so a
 * malformed field fails the whole update rather than being dropped by another branch.
 */
export const SessionUpdate = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
  kept: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((update) =>
    Object.values(update).some((value) => value !== undefined)
      ? undefined
      : "Expected archived, kept or pinned",
  ),
);

/** What a session update applied; `pinnedAt` is the server's pin time when pinned. */
export const SessionUpdateResult = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
  kept: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
  pinnedAt: Schema.optional(Schema.Number),
});
