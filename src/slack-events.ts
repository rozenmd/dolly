import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { attempt } from "./operations";

/** Open Session caps Slack request bodies at 1 MiB. */
export const MAX_SLACK_BYTES = 1_048_576;

/** Slack request timestamps must be within five minutes. */
const MAX_SKEW_SECONDS = 300;

export const SlackId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{2,32}$/));
const Ts = Schema.String.check(Schema.isPattern(/^\d{1,12}\.\d{1,9}$/));

const SlackFile = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  mimetype: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  url_private: Schema.optional(Schema.String),
});

const MessageEvent = Schema.Struct({
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  channel: Schema.optional(SlackId),
  channel_type: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  ts: Schema.optional(Ts),
  thread_ts: Schema.optional(Ts),
  team: Schema.optional(Schema.String),
  user_team: Schema.optional(Schema.String),
  user_profile: Schema.optional(Schema.Struct({ team: Schema.optional(Schema.String) })),
  files: Schema.optional(Schema.Array(SlackFile)),
});

const Envelope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("url_verification"), challenge: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("event_callback"),
    team_id: Schema.optional(Schema.String),
    event_id: Schema.optional(Schema.String),
    is_ext_shared_channel: Schema.optional(Schema.Boolean),
    event: MessageEvent,
  }),
]);

export type SlackMessageEvent = typeof MessageEvent.Type;

/** One admitted DM or mention. `threadTs` is the thread the reply goes to. */
export const SlackDelivery = Schema.Struct({
  kind: Schema.Literals(["direct_message", "mention"]),
  channel: SlackId,
  ts: Ts,
  threadTs: Ts,
  user: SlackId,
  text: Schema.String,
  /** True when this continues an existing thread rather than starting one. */
  reply: Schema.Boolean,
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      mimetype: Schema.String,
      size: Schema.Number,
      url: Schema.String,
    }),
  ),
});

export type SlackDelivery = typeof SlackDelivery.Type;

/** Copied from Open Session's event-routing.ts. */
export function shouldHandleAppMention(event: SlackMessageEvent) {
  return event.type === "app_mention" && !event.subtype && !event.bot_id;
}

export function shouldHandleDirectMessage(event: SlackMessageEvent) {
  return (
    event.type === "message" &&
    event.channel_type === "im" &&
    event.user !== "USLACK" &&
    !event.bot_id
  );
}

/**
 * True when the sender belongs to another Slack workspace (a Slack Connect partner in a
 * shared channel). A sender with no team is external only in a shared channel.
 */
export function isExternalSlackSender(check: {
  senderTeamId: string | null;
  homeTeamId: string | null;
  sharedChannel: boolean;
}) {
  if (check.senderTeamId && check.homeTeamId) return check.senderTeamId !== check.homeTeamId;

  return check.sharedChannel;
}

export function slackEventSenderTeam(event: SlackMessageEvent) {
  for (const value of [event.user_team, event.user_profile?.team, event.team])
    if (value) return value;

  return null;
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Slack's v0 HMAC over `v0:<timestamp>:<exact body>`, compared in constant time. */
export const verifySlackSignature = Effect.fn("Slack.verifySignature")(function* (
  secret: string,
  body: ArrayBuffer,
  timestamp: string,
  signature: string,
  now: number,
) {
  if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;

  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;

  const key = yield* attempt("slack.signature.key", () =>
    crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  );

  const prefix = new TextEncoder().encode(`v0:${timestamp}:`);
  const message = new Uint8Array(prefix.byteLength + body.byteLength);
  message.set(prefix);
  message.set(new Uint8Array(body), prefix.byteLength);

  const expected = `v0=${hex(yield* attempt("slack.signature.sign", () => crypto.subtle.sign("HMAC", key, message)))}`;
  let difference = expected.length ^ signature.length;

  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);

  return difference === 0;
});

export type ParsedSlackEvent =
  | { type: "challenge"; challenge: string }
  | { type: "ignored" }
  | {
      type: "event";
      kind: "direct_message" | "mention";
      eventId: string | null;
      sharedChannel: boolean;
      event: SlackMessageEvent & { channel: string; ts: string; user: string };
    };

export const parseSlackEvent = (body: ArrayBuffer): ParsedSlackEvent => {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))(
    new TextDecoder().decode(body),
  );

  if (Option.isNone(parsed)) return { type: "ignored" };
  const envelope = parsed.value;

  if (envelope.type === "url_verification")
    return { type: "challenge", challenge: envelope.challenge };
  const event = envelope.event;

  const kind = shouldHandleDirectMessage(event)
    ? "direct_message"
    : shouldHandleAppMention(event)
      ? "mention"
      : null;

  // Edits, deletions and other subtypes carry no sender; only messages and file shares start work.
  if (
    !kind ||
    (event.subtype && event.subtype !== "file_share") ||
    !event.channel ||
    !event.ts ||
    !event.user ||
    !/^[A-Z0-9]{2,32}$/.test(event.user)
  )
    return { type: "ignored" };

  return {
    type: "event",
    kind,
    eventId: envelope.event_id ?? null,
    sharedChannel: envelope.is_ext_shared_channel === true,
    event: { ...event, channel: event.channel, ts: event.ts, user: event.user },
  };
};

/** Remove the bot's own mention so the prompt reads as the person's request. */
export function slackPromptText(text: string, botUserId: string | null) {
  const cleaned = botUserId ? text.replaceAll(`<@${botUserId}>`, "") : text;

  return cleaned
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Slack mrkdwn from model Markdown: bold, links, headings and strike-through. Code is left alone. */
export function markdownToSlack(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
            .replace(/\*\*(.+?)\*\*/g, "*$1*")
            .replace(/__(.+?)__/g, "*$1*")
            .replace(/~~(.+?)~~/g, "~$1~")
            .replace(/!?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
            .replace(/^(\s*)[-*]\s+/gm, "$1• "),
    )
    .join("");
}
