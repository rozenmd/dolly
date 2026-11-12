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
  senders: Schema.Array(Login).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  secret: Schema.optional(Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256))),
});

export const WebhookProfile = Schema.Struct({
  secret: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(256)),
  senders: Schema.Array(Login),
  installations: Schema.Array(Schema.Struct({ repository: Repository, id: Id })),
});

const CommentEvent = Schema.Struct({
  action: Schema.Literal("created"),
  installation: Schema.Struct({ id: Id }),
  repository: Schema.Struct({ full_name: Repository }),
  sender: Schema.Struct({ login: Login, type: Schema.Literal("User") }),
  issue: Schema.Struct({ number: Id, pull_request: Schema.Struct({ url: Schema.String }) }),
  comment: Schema.Struct({ id: Id, body: Schema.String, user: Schema.Struct({ login: Login }) }),
});

export const GitHubEvent = Schema.Struct({
  repository: Repository,
  number: Id,
  commentId: Id,
  sender: Login,
  content: Schema.String,
});

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

  if (event !== "issue_comment") return { status: 204 as const };

  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CommentEvent))(
    new TextDecoder().decode(body),
  ).pipe(Effect.option);

  if (Option.isNone(parsed)) return { status: 204 as const };
  const value = parsed.value;

  const approved = profile.installations.some(
    (entry) =>
      entry.repository.toLowerCase() === value.repository.full_name.toLowerCase() &&
      entry.id === value.installation.id,
  );

  if (
    !approved ||
    !profile.senders.some((login) => login.toLowerCase() === value.sender.login.toLowerCase()) ||
    value.sender.login.toLowerCase() !== value.comment.user.login.toLowerCase()
  )
    return { status: 403 as const };
  const command = value.comment.body.trimStart();

  if (!/^\/pi(?:\s|$)/.test(command)) return { status: 204 as const };
  const content = command.slice(3).trim();

  if (!content || content.length > 16_384) return { status: 204 as const };

  return {
    status: 202 as const,
    event: {
      repository: value.repository.full_name.toLowerCase(),
      number: value.issue.number,
      commentId: value.comment.id,
      sender: value.sender.login,
      content,
    },
  };
});
