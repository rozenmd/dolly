import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Repository } from "./github-contracts";
import { integrationJson } from "./integration-http";
import { attempt, OperationError } from "./operations";
import { SlackId } from "./slack-events";
import { SLACK_BOT_EVENTS, SLACK_SCOPE_GROUPS, slackCreateAppUrl } from "./slack-manifest";

const BotToken = Schema.String.check(Schema.isPattern(/^xoxb-[A-Za-z0-9-]{10,250}$/));
const SigningSecret = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32,64}$/));

/** What the setup form sends. Omitted secrets keep their saved values; "" clears optional fields. */
export const SlackSetup = Schema.Struct({
  enabled: Schema.Boolean,
  botToken: Schema.optional(BotToken),
  signingSecret: Schema.optional(SigningSecret),
  allowedUserId: Schema.Union([SlackId, Schema.Literal("")]),
  defaultRepository: Schema.Union([Repository, Schema.Literal("")]),
});

export const SlackProfile = Schema.Struct({
  enabled: Schema.Boolean,
  botToken: BotToken,
  signingSecret: SigningSecret,
  /** Unset means every sender admitted by routing may drive Dolly. */
  allowedUserId: Schema.NullOr(SlackId),
  defaultRepository: Schema.NullOr(Repository),
  teamId: Schema.String,
  teamName: Schema.String,
  botUserId: Schema.String,
});

export type SlackProfile = typeof SlackProfile.Type;

const SlackResponse = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });

const decodeProfile = Schema.decodeUnknownEffect(SlackProfile);

export const readSlackProfile = (storage: DurableObjectStorage) =>
  attempt("slack.read", () => storage.get("slack:profile")).pipe(
    Effect.flatMap((raw) =>
      raw === undefined
        ? Effect.succeed(null)
        : decodeProfile(raw).pipe(Effect.orElseSucceed(() => null)),
    ),
  );

/** Call a Slack Web API method with the bot token. Slack reports failures as `ok: false` with HTTP 200. */
export const slackApi = Effect.fn("Slack.api")(function* (
  token: string,
  method: string,
  body: Readonly<Record<string, string | number | boolean>>,
) {
  const json = yield* integrationJson(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const status = yield* Schema.decodeUnknownEffect(SlackResponse)(json).pipe(
    Effect.mapError(
      () =>
        new OperationError({
          operation: `slack.${method}`,
          message: "Slack returned an unexpected response",
          details: null,
        }),
    ),
  );

  if (!status.ok)
    return yield* new OperationError({
      operation: `slack.${method}`,
      message: `Slack ${method} failed: ${status.error ?? "unknown_error"}`,
      details: { error: status.error ?? null },
    });

  return json;
});

const AuthTest = Schema.Struct({
  team_id: Schema.String,
  team: Schema.String,
  user_id: Schema.String,
});

export const configureSlack = Effect.fn("Slack.configure")(function* (
  storage: DurableObjectStorage,
  input: typeof SlackSetup.Type,
) {
  const saved = yield* readSlackProfile(storage);
  const botToken = input.botToken ?? saved?.botToken;
  const signingSecret = input.signingSecret ?? saved?.signingSecret;

  if (!botToken || !signingSecret)
    return { error: "Paste the bot token (xoxb-…) and signing secret from your Slack app." };

  // auth.test proves the token works and names the workspace whose members are not external.
  const identity = yield* slackApi(botToken, "auth.test", {}).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AuthTest)),
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
  );

  if (!identity.ok) return { error: `Slack rejected the bot token: ${identity.message}` };

  const profile: SlackProfile = {
    enabled: input.enabled,
    botToken,
    signingSecret,
    allowedUserId: input.allowedUserId || null,
    defaultRepository: input.defaultRepository || null,
    teamId: identity.value.team_id,
    teamName: identity.value.team,
    botUserId: identity.value.user_id,
  };

  yield* attempt("slack.save", () => storage.put("slack:profile", profile));

  return { configured: true };
});

export const removeSlack = (storage: DurableObjectStorage) =>
  attempt("slack.delete", () => storage.delete("slack:profile")).pipe(
    Effect.as({ configured: false }),
  );

/** Public status: never the token or signing secret. */
export const slackStatus = Effect.fn("Slack.status")(function* (
  storage: DurableObjectStorage,
  urls: { ingress: string; publicBaseUrl: string },
) {
  const profile = yield* readSlackProfile(storage);
  const webhookBaseUrl = urls.ingress.replace(/\/hooks\/github$/, "");

  return {
    configured: profile !== null,
    enabled: profile?.enabled ?? false,
    allowedUserId: profile?.allowedUserId ?? null,
    defaultRepository: profile?.defaultRepository ?? null,
    teamName: profile?.teamName ?? null,
    botUserId: profile?.botUserId ?? null,
    eventsUrl: webhookBaseUrl ? `${webhookBaseUrl}/slack/events` : null,
    actionsUrl: webhookBaseUrl ? `${webhookBaseUrl}/slack/actions` : null,
    createAppUrl:
      webhookBaseUrl && urls.publicBaseUrl
        ? slackCreateAppUrl({ webhookBaseUrl, publicBaseUrl: urls.publicBaseUrl, appName: "Dolly" })
        : null,
    scopes: SLACK_SCOPE_GROUPS,
    events: SLACK_BOT_EVENTS,
  };
});

/** Post (part of) a reply to a thread. Slack caps text at 40,000 characters. */
export const postSlackReply = Effect.fn("Slack.reply")(function* (
  token: string,
  channel: string,
  threadTs: string,
  text: string,
) {
  for (let offset = 0; offset < Math.max(text.length, 1); offset += 38_000)
    yield* slackApi(token, "chat.postMessage", {
      channel,
      thread_ts: threadTs,
      text: text.slice(offset, offset + 38_000) || " ",
      unfurl_links: false,
    });
});

const Replies = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      user: Schema.optional(Schema.String),
      bot_id: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
});

/** Bounded earlier thread text for routing a mention. */
export const slackThreadContext = Effect.fn("Slack.threadContext")(function* (
  token: string,
  channel: string,
  threadTs: string,
) {
  const json = yield* slackApi(token, "conversations.replies", {
    channel,
    ts: threadTs,
    limit: 20,
  });

  const replies = yield* Schema.decodeUnknownEffect(Replies)(json).pipe(
    Effect.orElseSucceed(() => ({ messages: [] })),
  );

  return replies.messages
    .map(
      (message) => `${message.bot_id ? "bot" : (message.user ?? "someone")}: ${message.text ?? ""}`,
    )
    .join("\n")
    .slice(-1500);
});

/** Image attachments are read with the bot token: at most six, skipping any over 4 MiB. */
export const MAX_SLACK_IMAGES = 6;
export const MAX_SLACK_IMAGE_BYTES = 4 * 1024 * 1024;

export const downloadSlackFile = Effect.fn("Slack.download")(function* (
  token: string,
  url: string,
) {
  if (!url.startsWith("https://files.slack.com/"))
    return yield* new OperationError({
      operation: "slack.download",
      message: "Unexpected Slack file URL",
      details: null,
    });

  const response = yield* attempt("slack.download", (signal) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal }),
  );

  if (!response.ok)
    return yield* new OperationError({
      operation: "slack.download",
      message: `Slack file download returned HTTP ${response.status}`,
      details: { status: response.status },
    });
  const bytes = yield* attempt("slack.download.read", () => response.arrayBuffer());

  if (bytes.byteLength > MAX_SLACK_IMAGE_BYTES)
    return yield* new OperationError({
      operation: "slack.download",
      message: "Slack image exceeds 4 MiB",
      details: null,
    });

  return new Uint8Array(bytes);
});
