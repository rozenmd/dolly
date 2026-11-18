import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DEFAULT_AUTO_FALLBACK,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_SPEED,
  DEFAULT_THINKING_LEVEL,
  DefaultModelSetting,
  SessionModel,
  Speed,
  ThinkingLevel,
  fastSupported,
  modelProvider,
} from "./models";

/** Owner defaults for new sessions, one storage key per setting so each can be reset alone. */
const KEYS = {
  model: "settings:default-model",
  thinkingLevel: "settings:default-effort",
  speed: "settings:default-speed",
  autoFallback: "settings:auto-fallback",
} as const;

export const DEFAULT_MODEL_KEY = KEYS.model;

const DECODERS = {
  model: Schema.decodeUnknownOption(SessionModel),
  thinkingLevel: Schema.decodeUnknownOption(ThinkingLevel),
  speed: Schema.decodeUnknownOption(Speed),
  autoFallback: Schema.decodeUnknownOption(Schema.Boolean),
};

/** The owner's saved choices; `null` follows the built-in default. */
export type StoredDefaults = {
  model: typeof SessionModel.Type | null;
  thinkingLevel: typeof ThinkingLevel.Type | null;
  speed: Speed | null;
  autoFallback: boolean | null;
};

export async function readDefaults(storage: DurableObjectStorage): Promise<StoredDefaults> {
  const values = await storage.get(Object.values(KEYS));

  // A saved value dropped from the catalog (a retired model) reads as unset.
  return {
    model: Option.getOrNull(DECODERS.model(values.get(KEYS.model))),
    thinkingLevel: Option.getOrNull(DECODERS.thinkingLevel(values.get(KEYS.thinkingLevel))),
    speed: Option.getOrNull(DECODERS.speed(values.get(KEYS.speed))),
    autoFallback: Option.getOrNull(DECODERS.autoFallback(values.get(KEYS.autoFallback))),
  };
}

/** Saves the given settings; `null` clears one back to its built-in default, absent leaves it. */
export async function writeDefaults(
  storage: DurableObjectStorage,
  setting: typeof DefaultModelSetting.Type,
) {
  const changes = [
    [KEYS.model, setting.model],
    [KEYS.thinkingLevel, setting.thinkingLevel],
    [KEYS.speed, setting.speed],
    [KEYS.autoFallback, setting.autoFallback],
  ] as const;

  await storage.transaction(async (tx) => {
    for (const [key, value] of changes) {
      if (value === null) await tx.delete(key);
      else if (value !== undefined) await tx.put(key, value);
    }
  });
}

/**
 * The owner's default applies while its subscription is connected; otherwise new
 * conversations use the built-in default for whichever subscription is connected.
 */
export function effectiveDefaultModel(stored: string | null, chatgpt: boolean, claude: boolean) {
  if (stored && (modelProvider(stored) === "anthropic" ? claude : chatgpt)) return stored;

  if (chatgpt) return DEFAULT_OPENAI_MODEL;

  if (claude) return DEFAULT_CLAUDE_MODEL;

  return stored ?? DEFAULT_OPENAI_MODEL;
}

/** What `GET /api/settings/model` reports: saved choices and what a new session uses now. */
export function defaultsView(stored: StoredDefaults, chatgpt: boolean, claude: boolean) {
  return {
    model: stored.model,
    effective: effectiveDefaultModel(stored.model, chatgpt, claude),
    thinkingLevel: stored.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    speed: stored.speed ?? DEFAULT_SPEED,
    autoFallback: stored.autoFallback ?? DEFAULT_AUTO_FALLBACK,
  };
}

/** Per-session record beside Pi's conversation: sidebar state and model options Pi doesn't keep. */
export type SessionMetadata = {
  createdAt?: number;
  archived?: boolean;
  kept?: boolean;
  speed?: Speed;
  autoFallback?: boolean;
  /** The model an automatic fallback last switched to; it never falls back again from there. */
  fellBackTo?: string;
};

/** Transcript entry recording an automatic model switch: `{ from, to, reason }`. */
export const FALLBACK_ENTRY = "dolly.fallback";

export const sessionMetadataKey = (conversationId: ConversationId) =>
  `session-meta:${conversationId}`;

/**
 * Whether a failed response means the subscription has run out, not that the request hit a
 * passing throttle. ChatGPT reports `subscription_sharing_usage_limit_exceeded`; Claude
 * subscriptions report a usage limit. A plain rate limit is retried instead.
 */
export function quotaExhausted(message: AssistantMessage) {
  if (message.stopReason !== "error" || !message.errorMessage) return false;

  return /usage.?limit|limit.?reached|insufficient_quota|quota|out of (?:extra )?usage|credit balance/i.test(
    message.errorMessage,
  );
}

/** Whether Pi retries this failure itself; then the retry simply runs on the new model. */
export const retriedByPi = (message: AssistantMessage) => isRetryableAssistantError(message);

/**
 * The model a session moves to when `from` runs out: the other subscription, since one
 * subscription's limit covers all of its models. The owner's default is preferred when it is on
 * that subscription. Undefined when the other subscription isn't connected.
 */
export function fallbackModel(
  from: string,
  stored: string | null,
  connected: { openai: boolean; anthropic: boolean },
) {
  const target = modelProvider(from) === "anthropic" ? "openai" : "anthropic";

  if (!connected[target]) return undefined;

  if (stored && modelProvider(stored) === target) return stored;

  return target === "anthropic" ? DEFAULT_CLAUDE_MODEL : DEFAULT_OPENAI_MODEL;
}

/**
 * Ask OpenAI for priority processing on a fast session. The payload is the Responses API body
 * Pi built; other APIs and standard sessions are left untouched.
 */
/** Pi hands provider hooks the request body untyped; Responses API bodies are JSON objects. */
export const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

export function prioritized(
  payload: typeof RequestBody.Type,
  api: string,
  model: string,
  speed: Speed | undefined,
) {
  if (speed !== "fast" || !fastSupported(model) || !api.startsWith("openai-")) return undefined;

  return { ...payload, service_tier: "priority" };
}
