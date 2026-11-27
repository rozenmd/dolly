import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ScreenshotReference } from "./images";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/));

export const Repository = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
);

const Ref = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * A plain branch name: no refs/ prefix, leading punctuation, "..", empty or dot-led components,
 * trailing dot or slash, or .lock component. Writes to the default branch are refused separately.
 */
export const BranchName = Schema.String.check(
  Schema.isPattern(
    /^(?!refs\/)(?!.*(?:\.\.|\/\/|\/\.|\.lock(?:\/|$)|[./]$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/,
  ),
);

const Branch = BranchName;

const Path = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\/$)[^\p{Cc}\\]+$/u),
);

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

const PullNumber = Schema.Int.check(Schema.isGreaterThan(0));

/** GitHub Actions run and job ids, which outgrow PR numbers but stay safe integers. */
const ActionsId = Schema.Int.check(Schema.isGreaterThan(0));

const Page = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100));

const LineNumber = Schema.Int.check(Schema.isGreaterThan(0));

const Side = Schema.Literals(["LEFT", "RIGHT"]);

const CommentBody = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536));

const PullTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const PullBody = Schema.String.check(Schema.isMaxLength(32_768));

/**
 * An optional field that also accepts null and decodes it as omitted. Models fill optional fields
 * with null (the github tool's schema reaches Claude with them nullable), and GitHub treats a
 * missing start_line or start_side as a single-line comment.
 */
const omittedWhenNull = <A>(schema: Schema.Codec<A>) =>
  Schema.optional(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(
      Schema.optional(schema),
      SchemaTransformation.transformOptional<A | undefined, A | null | undefined>({
        decode: Option.filter(Predicate.isNotNullish),
        encode: (value) => value,
      }),
    ),
  );

/** An inline review comment anchored with GitHub's line/side model (never the deprecated position). */
export const ReviewComment = Schema.Struct({
  path: Path,
  body: CommentBody,
  line: LineNumber,
  side: Side,
  start_line: omittedWhenNull(LineNumber),
  start_side: omittedWhenNull(Side),
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

/** The longest review body the github tool accepts. */
export const MAX_REVIEW_BODY = 65_000;

export const GitHubRequest = Schema.Struct({
  operation: Schema.Union([
    Schema.Struct({ action: Schema.Literal("repositories") }),
    Schema.Struct({
      action: Schema.Literal("read_file"),
      repository: Repository,
      path: Path,
      ref: Ref,
      /** 1-based line to start from; reads return at most 2,000 lines or 50 KiB. */
      offset: Schema.optional(LineNumber),
      limit: Schema.optional(LineNumber.check(Schema.isLessThanOrEqualTo(2000))),
    }),
    Schema.Struct({
      action: Schema.Literal("list_files"),
      repository: Repository,
      ref: Ref,
      /** Optional directory to list beneath; omit for the whole repository. */
      path: Schema.optional(Path),
      page: Schema.optional(Page),
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
      title: PullTitle,
      body: PullBody,
    }),
    Schema.Struct({
      /** Edits only the title and/or description; state, base and merging are never touched. */
      action: Schema.Literal("update_pull_request"),
      repository: Repository,
      number: PullNumber,
      title: Schema.optional(PullTitle),
      /** Replaces the whole description; read_pull_request first to keep what should stay. */
      body: Schema.optional(PullBody),
    }),
    Schema.Struct({
      action: Schema.Literal("upload_screenshot"),
      repository: Repository,
      number: PullNumber,
      image: ScreenshotReference,
      caption: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
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
      /**
       * Discussion, reviews and inline threads, newest activity first, in pages that fit the tool
       * output; `unresolved` keeps only review threads nobody resolved. A call without `cursor`
       * reads GitHub once; its `cursor` serves the later pages from that read.
       */
      action: Schema.Literal("list_pull_request_comments"),
      repository: Repository,
      number: PullNumber,
      // Not the shared Page: a big conversation can have more than 100 pages.
      page: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
      filter: Schema.optional(Schema.Literals(["all", "unresolved"])),
    }),
    Schema.Struct({
      action: Schema.Literal("read_pull_request_checks"),
      repository: Repository,
      number: PullNumber,
    }),
    Schema.Struct({
      /** A workflow run's jobs (latest attempt) with ids for read_job_log and their steps. */
      action: Schema.Literal("list_workflow_jobs"),
      repository: Repository,
      run_id: ActionsId,
    }),
    Schema.Struct({
      /** A window of one Actions job's log; the tail when offset is omitted. */
      action: Schema.Literal("read_job_log"),
      repository: Repository,
      job_id: ActionsId,
      offset: Schema.optional(LineNumber),
      limit: Schema.optional(LineNumber.check(Schema.isLessThanOrEqualTo(2000))),
    }),
    Schema.Struct({
      action: Schema.Literal("create_review"),
      repository: Repository,
      number: PullNumber,
      /** Must equal the pull request's current head SHA, so comments land on the reviewed diff. */
      commit_id: Sha,
      body: Schema.String.check(Schema.isMaxLength(MAX_REVIEW_BODY)),
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
    Schema.Struct({
      /** Marks the review thread holding `comment_id` resolved; a resolved thread stays resolved. */
      action: Schema.Literal("resolve_review_thread"),
      repository: Repository,
      number: PullNumber,
      comment_id: PullNumber,
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
    /** Present when content is a window of a longer file. */
    lines: Schema.optional(Schema.String),
    nextOffset: Schema.optional(Schema.Number),
    note: Schema.optional(Schema.String),
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
      "files",
      "pull_request_details",
      "pull_request_files",
      "pull_request_comments",
      "pull_request_checks",
      "workflow_jobs",
      "job_log",
      "review",
      "review_comment",
      "review_thread",
      "screenshot",
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
