import * as Schema from "effect/Schema";

export const SavedSession = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  /** Pi thinking level; absent for sessions saved before it was reported. */
  thinkingLevel: Schema.optional(Schema.String),
  title: Schema.String,
  repository: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.optional(Schema.Boolean),
  ref: Schema.optional(Schema.String),
  /** The agent has live, non-background work in progress. */
  running: Schema.optional(Schema.Boolean),
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
