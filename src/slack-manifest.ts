/**
 * The Slack app manifest Dolly needs. Slack reads every scope, event and URL from it;
 * a manifest cannot carry credentials, so the bot token and signing secret are pasted
 * after the app exists.
 */

/** Bot token scopes, grouped by what they buy. */
export const SLACK_SCOPE_GROUPS: { label: string; items: string[] }[] = [
  {
    label: "Writing",
    items: [
      "chat:write",
      "chat:write.customize",
      "files:write",
      "reactions:write",
      "assistant:write",
    ],
  },
  { label: "History", items: ["channels:history", "groups:history", "im:history", "mpim:history"] },
  {
    label: "Events, links, and emoji",
    items: ["app_mentions:read", "links:read", "links:write", "emoji:read"],
  },
  {
    label: "Channels and people",
    items: [
      "channels:read",
      "groups:read",
      "im:read",
      "channels:manage",
      "groups:write",
      "channels:join",
      "im:write",
      "users:read",
    ],
  },
];

export const SLACK_BOT_SCOPES: string[] = SLACK_SCOPE_GROUPS.flatMap((group) => group.items);

export const SLACK_BOT_EVENTS: string[] = [
  "app_mention",
  "assistant_thread_started",
  "link_shared",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
];

export interface SlackManifestOptions {
  /** Public UI base whose hostname Slack watches for session-link unfurls. */
  publicBaseUrl: string;
  /** The dolly-ingress Worker's base URL. Slack POSTs events and actions here. */
  webhookBaseUrl: string;
  appName: string;
}

/** Slack rejects an app name over 35 characters rather than truncating it. */
function clampName(name: string, max: number) {
  const trimmed = name.trim() || "Dolly";

  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

const base = (url: string) => url.replace(/\/+$/, "");

export function buildSlackManifest(options: SlackManifestOptions) {
  const appName = clampName(options.appName, 35);

  return {
    display_information: {
      name: appName,
      description: `${appName} coding agent: DMs, mentions, session channels and interactive controls.`,
      background_color: "#4a154b",
    },
    features: {
      unfurl_domains: [new URL(options.publicBaseUrl).hostname],
      bot_user: { display_name: clampName(appName, 80), always_online: true },
      assistant_view: {
        assistant_description: "Ask for a change, a review, or a question about the code.",
        suggested_prompts: [],
      },
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      event_subscriptions: {
        request_url: `${base(options.webhookBaseUrl)}/slack/events`,
        bot_events: SLACK_BOT_EVENTS,
      },
      interactivity: {
        is_enabled: true,
        request_url: `${base(options.webhookBaseUrl)}/slack/actions`,
      },
      socket_mode_enabled: false,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** Slack's create-app form, pre-filled from the manifest. */
export function slackCreateAppUrl(options: SlackManifestOptions) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(buildSlackManifest(options)))}`;
}
