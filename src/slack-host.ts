import { Buffer } from "node:buffer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Credentials } from "./credentials";
import { GitHub } from "./github";
import { PromptImage, storeImages } from "./images";
import { OperationError } from "./operations";
import {
  downloadSlackFile,
  MAX_SLACK_IMAGES,
  postSlackReply,
  readSlackProfile,
  slackApi,
  slackThreadContext,
} from "./slack";
import { markdownToSlack, type SlackDelivery } from "./slack-events";
import type { SlackHost, SlackPrepared } from "./slack-inbox";
import { ASK_MODE_NOTE, classifyMention, prActionPrompt, SLACK_SESSION_NOTE } from "./slack-intent";

const ImageType = PromptImage.fields.mimeType;
const isImageType = Schema.is(ImageType);

const ChannelInfo = Schema.Struct({
  channel: Schema.Struct({ name: Schema.optional(Schema.String) }),
});

function makeSlackHost(
  deps: { storage: DurableObjectStorage; credentials: Credentials; screenshots: R2Bucket },
  github: {
    enrolledRepositories: Effect.Effect<
      readonly { fullName: string; description: string | null }[],
      OperationError
    >;
  },
): SlackHost {
  const profile = readSlackProfile(deps.storage).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(
            new OperationError({
              operation: "slack.profile",
              message: "Slack is not configured",
              details: null,
            }),
          ),
    ),
  );

  const images = (token: string, input: SlackDelivery) =>
    Effect.forEach(
      input.files
        .flatMap((file) =>
          isImageType(file.mimetype) ? [{ ...file, mimetype: file.mimetype }] : [],
        )
        .slice(0, MAX_SLACK_IMAGES),
      (file) =>
        downloadSlackFile(token, file.url).pipe(
          Effect.map((bytes): PromptImage | null => ({
            mimeType: file.mimetype,
            data: Buffer.from(bytes).toString("base64"),
          })),
          // Skip an image that cannot be inlined rather than failing the message.
          Effect.orElseSucceed(() => null),
        ),
    ).pipe(
      Effect.map((list) => list.filter((image) => image !== null)),
      Effect.flatMap((list) =>
        Effect.tryPromise({
          try: () => storeImages(deps.screenshots, list),
          catch: (cause) =>
            new OperationError({
              operation: "slack.images",
              message: String(cause),
              details: null,
            }),
        }),
      ),
    );

  const prepare = Effect.fn("Slack.prepare")(function* (input: SlackDelivery, isNew: boolean) {
    const slack = yield* profile;
    const enrolled = yield* github.enrolledRepositories.pipe(Effect.orElseSucceed(() => []));

    const enrolledName = (name: string | null) =>
      name
        ? (enrolled.find((repo) => repo.fullName.toLowerCase() === name.toLowerCase())?.fullName ??
          null)
        : null;

    const fallback = enrolledName(slack.defaultRepository);
    const origin = input.kind === "direct_message" ? "Slack DM" : "Slack mention";
    let task = input.text;
    let note = SLACK_SESSION_NOTE;
    let workspace: SlackPrepared["workspace"] = null;

    if (isNew) {
      workspace = fallback ? { repository: fallback } : null;

      if (input.kind === "mention") {
        const context = input.reply
          ? yield* slackThreadContext(slack.botToken, input.channel, input.threadTs).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;

        const channelName = yield* slackApi(slack.botToken, "conversations.info", {
          channel: input.channel,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ChannelInfo)),
          Effect.map((info) => info.channel.name ?? null),
          Effect.orElseSucceed(() => null),
        );

        const intent = yield* classifyMention(deps.credentials, input.text, {
          channelName,
          context,
          repositories: enrolled,
        });

        if (intent && intent.action !== "none" && intent.prNumber !== null && fallback) {
          workspace = { repository: fallback, ref: `refs/pull/${intent.prNumber}/head` };
          task = prActionPrompt(intent.action, fallback, intent.prNumber, input.text);
        } else if (intent) {
          const repository = enrolledName(intent.repo) ?? fallback;
          workspace = repository ? { repository } : null;

          if (intent.mode === "ask") note = `${note} ${ASK_MODE_NOTE}`;
        }
      }
    }

    const text = `[${note}]\n\n${origin} from <@${input.user}>:\n\n${task}`;
    const blocks = input.files.length ? yield* images(slack.botToken, input) : [];

    return {
      content: blocks.length ? [{ type: "text" as const, text }, ...blocks] : text,
      workspace,
    } satisfies SlackPrepared;
  });

  const reply = Effect.fn("Slack.replyThread")(function* (input: SlackDelivery, text: string) {
    const slack = yield* profile;
    yield* postSlackReply(slack.botToken, input.channel, input.threadTs, markdownToSlack(text));
  });

  return { prepare, reply };
}

/** Slack routing, attachments and thread replies for the durable delivery task. */
export class SlackHostService extends Context.Service<SlackHostService, SlackHost>()(
  "dolly/SlackHost",
) {
  static readonly layer = (deps: {
    storage: DurableObjectStorage;
    credentials: Credentials;
    screenshots: R2Bucket;
  }) =>
    Layer.effect(
      SlackHostService,
      Effect.map(GitHub, (github) => makeSlackHost(deps, github)),
    );
}
