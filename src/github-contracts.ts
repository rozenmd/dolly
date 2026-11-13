import * as Schema from "effect/Schema";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/));

export const Repository = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/),
);

const Ref = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const Branch = Schema.String.check(Schema.isPattern(/^pi-hard\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/));

const Path = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\/$)[^\p{Cc}\\]+$/u),
);

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

export const GitHubSetup = Schema.Struct({
  owner: Name,
  ownerType: Schema.Literals(["personal", "organization"]),
  repositories: Schema.Array(Repository).check(Schema.isMinLength(1)),
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
      content: Schema.String.check(Schema.isMaxLength(32_768)),
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
