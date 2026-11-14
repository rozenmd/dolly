import * as Schema from "effect/Schema";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/));

export const Repository = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
);

const Ref = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const Branch = Schema.String.check(Schema.isPattern(/^dolly\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/));

const Path = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\/$)[^\p{Cc}\\]+$/u),
);

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

const PullNumber = Schema.Int.check(Schema.isGreaterThan(0));

const Page = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100));

const LineNumber = Schema.Int.check(Schema.isGreaterThan(0));

const Side = Schema.Literals(["LEFT", "RIGHT"]);

const CommentBody = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536));

/** An inline review comment anchored with GitHub's line/side model (never the deprecated position). */
export const ReviewComment = Schema.Struct({
  path: Path,
  body: CommentBody,
  line: LineNumber,
  side: Side,
  start_line: Schema.optional(LineNumber),
  start_side: Schema.optional(Side),
});

export const GitHubAccounts = Schema.Struct({ accounts: Schema.Array(Name) });

export const EnrollRepository = Schema.Struct({ repository: Repository });

export const EnrolledRepository = Schema.Struct({
  fullName: Repository,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
  description: Schema.NullOr(Schema.String),
});

export const GitHubSetup = Schema.Struct({
  owner: Name,
  /** The public ingress Worker's webhook URL, ending in /hooks/github. */
  ingress: Schema.String.check(
    Schema.isPattern(/^https:\/\/[a-zA-Z0-9.-]+(?::443)?\/hooks\/github$/),
  ),
  ownerType: Schema.Literals(["personal", "organization"]),
  repositories: Schema.optional(Schema.Array(Repository).check(Schema.isMinLength(1))),
});

export const GitHubRequest = Schema.Struct({
  operation: Schema.Union([
    Schema.Struct({ action: Schema.Literal("repositories") }),
    Schema.Struct({
      action: Schema.Literal("read_file"),
      repository: Repository,
      path: Path,
      ref: Ref,
    }),
    Schema.Struct({
      action: Schema.Literal("create_branch"),
      repository: Repository,
      branch: Branch,
      base: Ref,
    }),
    Schema.Struct({
      action: Schema.Literal("write_file"),
      repository: Repository,
      branch: Branch,
      path: Path,
      content: Schema.String,
      message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      sha: Schema.optional(Sha),
    }),
    Schema.Struct({
      action: Schema.Literal("open_pull_request"),
      repository: Repository,
      branch: Branch,
      base: Ref,
      title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      body: Schema.String.check(Schema.isMaxLength(32_768)),
    }),
    Schema.Struct({
      action: Schema.Literal("read_pull_request"),
      repository: Repository,
      number: PullNumber,
    }),
    Schema.Struct({
      action: Schema.Literal("list_pull_request_files"),
      repository: Repository,
      number: PullNumber,
      page: Schema.optional(Page),
    }),
    Schema.Struct({
      action: Schema.Literal("list_pull_request_comments"),
      repository: Repository,
      number: PullNumber,
      page: Schema.optional(Page),
    }),
    Schema.Struct({
      action: Schema.Literal("read_pull_request_checks"),
      repository: Repository,
      number: PullNumber,
    }),
    Schema.Struct({
      action: Schema.Literal("create_review"),
      repository: Repository,
      number: PullNumber,
      /** Must equal the pull request's current head SHA, so comments land on the reviewed diff. */
      commit_id: Sha,
      body: Schema.String.check(Schema.isMaxLength(65_000)),
      /** PENDING leaves the review unsubmitted for a human to inspect. Approvals are never allowed. */
      event: Schema.Literals(["COMMENT", "PENDING"]),
      comments: Schema.Array(ReviewComment).check(Schema.isMaxLength(50)),
    }),
    Schema.Struct({
      action: Schema.Literal("reply_to_review_comment"),
      repository: Repository,
      number: PullNumber,
      comment_id: PullNumber,
      body: CommentBody,
    }),
  ]),
});

export const GitHubResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("repositories"), repositories: Schema.Array(Repository) }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    sha: Sha,
    content: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("branch"), name: Schema.String, sha: Sha }),
  Schema.Struct({ kind: Schema.Literal("commit"), sha: Sha }),
  Schema.Struct({
    kind: Schema.Literal("pull_request"),
    number: Schema.Number,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literals([
      "pull_request_details",
      "pull_request_files",
      "pull_request_comments",
      "pull_request_checks",
      "review",
      "review_comment",
    ]),
    data: Schema.Unknown,
  }),
]);

export const IntegrationFailure = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.String,
  message: Schema.String,
});

export const GitHubReply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: GitHubResult }),
  IntegrationFailure,
]);
