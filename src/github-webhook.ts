import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Repository } from "./github-contracts";
import { attempt } from "./operations";

export const MAX_WEBHOOK_BYTES = 262_144;
const Login = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/));
const Id = Schema.Int.check(Schema.isGreaterThan(0));

export const WebhookUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/[a-zA-Z0-9.-]+(?::443)?\/hooks\/github$/),
);

export const WebhookSetup = Schema.Struct({
  /** Who may run /dolly commands. An empty list stops every command. */
  senders: Schema.Array(Login),
  secret: Schema.optional(Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256))),
  /** Review new pull requests these senders open in enrolled repositories. Omitted keeps the saved choice. */
  reviews: Schema.optional(Schema.Boolean),
});

export const WebhookProfile = Schema.Struct({
  secret: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
  senders: Schema.Array(Login),
  reviews: Schema.optional(Schema.Boolean),
});

const CommentEvent = Schema.Struct({
  action: Schema.Literal("created"),
  installation: Schema.Struct({ id: Id }),
  repository: Schema.Struct({ full_name: Repository }),
  sender: Schema.Struct({ login: Login, type: Schema.Literal("User") }),
  issue: Schema.Struct({ number: Id, pull_request: Schema.Struct({ url: Schema.String }) }),
  comment: Schema.Struct({ id: Id, body: Schema.String, user: Schema.Struct({ login: Login }) }),
});

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

/** A pull request becoming ready for review: opened, reopened or taken out of draft. */
const ReviewEvent = Schema.Struct({
  action: Schema.Literals(["opened", "reopened", "ready_for_review"]),
  installation: Schema.Struct({ id: Id }),
  repository: Schema.Struct({ full_name: Repository }),
  sender: Schema.Struct({ login: Login, type: Schema.Literal("User") }),
  number: Id,
  pull_request: Schema.Struct({
    draft: Schema.optional(Schema.Boolean),
    head: Schema.Struct({
      sha: Sha,
      repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
    }),
  }),
});

const Pulls = Schema.optional(Schema.Array(Schema.Struct({ number: Id })));

const CiBase = {
  installation: Schema.Struct({ id: Id }),
  repository: Schema.Struct({ full_name: Repository }),
};

const FAILED = ["failure", "timed_out", "startup_failure"];

/** The CI events that can move a wait forward; anything else about CI is noise. */
const CiEvents = {
  check_run: Schema.Struct({
    ...CiBase,
    action: Schema.Literal("completed"),
    check_run: Schema.Struct({
      head_sha: Sha,
      conclusion: Schema.NullOr(Schema.String),
      pull_requests: Pulls,
    }),
  }),
  check_suite: Schema.Struct({
    ...CiBase,
    action: Schema.Literal("completed"),
    check_suite: Schema.Struct({ head_sha: Sha, pull_requests: Pulls }),
  }),
  status: Schema.Struct({ ...CiBase, sha: Sha, state: Schema.String }),
  workflow_run: Schema.Struct({
    ...CiBase,
    action: Schema.Literal("completed"),
    workflow_run: Schema.Struct({
      id: Id,
      head_sha: Sha,
      head_branch: Schema.optional(Schema.NullOr(Schema.String)),
      path: Schema.optional(Schema.String),
      pull_requests: Pulls,
    }),
  }),
  workflow_job: Schema.Struct({
    ...CiBase,
    action: Schema.Literal("completed"),
    workflow_job: Schema.Struct({
      run_id: Id,
      head_sha: Sha,
      conclusion: Schema.NullOr(Schema.String),
    }),
  }),
  pull_request: Schema.Struct({
    ...CiBase,
    action: Schema.Literal("closed"),
    number: Id,
    pull_request: Schema.Struct({ head: Schema.Struct({ sha: Sha }) }),
  }),
};

/**
 * A CI change a wait may care about. It only pulls a matching wait's next poll forward; the wait
 * still reads GitHub itself, so a forged or stale event can cost a poll but never a wrong result.
 */
export type CiEvent = {
  installationId: number;
  repository: string;
  shas: string[];
  pulls: number[];
  runId?: number;
  /** Workflow file path and branch or tag, for a run named by workflow and ref. */
  workflowPath?: string;
  ref?: string;
};

function ciEvent(event: string, text: string): CiEvent | undefined {
  const json = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text),
  );

  const base = (value: { installation: { id: number }; repository: { full_name: string } }) => ({
    installationId: value.installation.id,
    repository: value.repository.full_name.toLowerCase(),
  });

  const numbers = (pulls?: readonly { number: number }[]) =>
    (pulls ?? []).map((pull) => pull.number);

  if (event === "check_run") {
    const value = Option.getOrUndefined(Schema.decodeUnknownOption(CiEvents.check_run)(json));

    // A passing check alone rarely settles anything; check_suite covers that.
    if (!value || !FAILED.includes(value.check_run.conclusion ?? "")) return undefined;

    return {
      ...base(value),
      shas: [value.check_run.head_sha],
      pulls: numbers(value.check_run.pull_requests),
    };
  }

  if (event === "check_suite") {
    const value = Option.getOrUndefined(Schema.decodeUnknownOption(CiEvents.check_suite)(json));

    if (!value) return undefined;

    return {
      ...base(value),
      shas: [value.check_suite.head_sha],
      pulls: numbers(value.check_suite.pull_requests),
    };
  }

  if (event === "status") {
    const value = Option.getOrUndefined(Schema.decodeUnknownOption(CiEvents.status)(json));

    if (!value || value.state === "pending") return undefined;

    return { ...base(value), shas: [value.sha], pulls: [] };
  }

  if (event === "workflow_run") {
    const value = Option.getOrUndefined(Schema.decodeUnknownOption(CiEvents.workflow_run)(json));

    if (!value) return undefined;
    const run = value.workflow_run;

    const result: CiEvent = {
      ...base(value),
      shas: [run.head_sha],
      pulls: numbers(run.pull_requests),
      runId: run.id,
    };

    if (run.path) result.workflowPath = run.path;

    if (run.head_branch) result.ref = run.head_branch;

    return result;
  }

  if (event === "workflow_job") {
    const value = Option.getOrUndefined(Schema.decodeUnknownOption(CiEvents.workflow_job)(json));

    if (!value || !FAILED.includes(value.workflow_job.conclusion ?? "")) return undefined;

    return {
      ...base(value),
      shas: [value.workflow_job.head_sha],
      pulls: [],
      runId: value.workflow_job.run_id,
    };
  }

  if (event === "pull_request") {
    const value = Option.getOrUndefined(Schema.decodeUnknownOption(CiEvents.pull_request)(json));

    if (!value) return undefined;

    return { ...base(value), shas: [value.pull_request.head.sha], pulls: [value.number] };
  }

  return undefined;
}

export const GitHubEvent = Schema.Struct({
  installationId: Id,
  repository: Repository,
  number: Id,
  commentId: Id,
  sender: Login,
  content: Schema.String,
});

/** An automatic review of a pull request's head commit. */
export const GitHubReview = Schema.Struct({
  kind: Schema.Literal("review"),
  installationId: Id,
  repository: Repository,
  number: Id,
  sha: Sha,
  sender: Login,
});

/** What a GitHub thread delivers: a /dolly command or an automatic review. */
export type GitHubDelivery = typeof GitHubEvent.Type | typeof GitHubReview.Type;

/** The key a delivery is deduplicated by within its thread. */
export function deliveryKey(delivery: GitHubDelivery) {
  return "kind" in delivery ? `review:${delivery.sha}` : String(delivery.commentId);
}

export const verifyWebhook = Effect.fn("GitHub.verifyWebhook")(function* (
  profile: typeof WebhookProfile.Type,
  body: ArrayBuffer,
  signature: string,
  event: string,
) {
  if (body.byteLength > MAX_WEBHOOK_BYTES) return { status: 413 as const };

  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return { status: 401 as const };

  const key = yield* attempt("github.webhook.key", () =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(profile.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    ),
  );

  const bytes = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );

  const valid = yield* attempt("github.webhook.signature", () =>
    crypto.subtle.verify("HMAC", key, bytes, body),
  );

  if (!valid) return { status: 401 as const };

  if (event === "pull_request" && profile.reviews) {
    const review = reviewEvent(profile, new TextDecoder().decode(body));

    if (review) return { status: 202 as const, kind: "review" as const, review };
  }

  if (event !== "issue_comment") {
    const ci = ciEvent(event, new TextDecoder().decode(body));

    return ci ? { status: 202 as const, kind: "ci" as const, ci } : { status: 204 as const };
  }

  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CommentEvent))(
    new TextDecoder().decode(body),
  ).pipe(Effect.option);

  if (Option.isNone(parsed)) return { status: 204 as const };
  const value = parsed.value;

  if (
    !profile.senders.some((login) => login.toLowerCase() === value.sender.login.toLowerCase()) ||
    value.sender.login.toLowerCase() !== value.comment.user.login.toLowerCase()
  )
    return { status: 403 as const };
  const command = value.comment.body.trimStart();

  if (!/^\/dolly(?:\s|$)/.test(command)) return { status: 204 as const };
  const content = command.slice("/dolly".length).trim();

  if (!content || content.length > 16_384) return { status: 204 as const };

  return {
    status: 202 as const,
    kind: "comment" as const,
    event: {
      installationId: value.installation.id,
      repository: value.repository.full_name.toLowerCase(),
      number: value.issue.number,
      commentId: value.comment.id,
      sender: value.sender.login,
      content,
    },
  };
});

/**
 * A pull request an allowed sender opened (or made ready) on a branch of the same repository.
 * Drafts wait for ready_for_review; forks are never reviewed automatically.
 */
function reviewEvent(
  profile: typeof WebhookProfile.Type,
  text: string,
): typeof GitHubReview.Type | undefined {
  const value = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(ReviewEvent))(text),
  );

  if (!value || value.pull_request.draft) return undefined;
  const repository = value.repository.full_name.toLowerCase();

  if (value.pull_request.head.repo?.full_name.toLowerCase() !== repository) return undefined;

  if (!profile.senders.some((login) => login.toLowerCase() === value.sender.login.toLowerCase()))
    return undefined;

  return {
    kind: "review",
    installationId: value.installation.id,
    repository,
    number: value.number,
    sha: value.pull_request.head.sha,
    sender: value.sender.login,
  };
}
