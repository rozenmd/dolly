import * as Schema from "effect/Schema";
import { WorkspaceInput } from "./workspace";
import { SPEEDS } from "./model-capabilities";

/**
 * Models that Sign in with ChatGPT tokens may call on api.openai.com. Pi's OpenAI catalog owns
 * their definitions; this list matches the models other connected agents offer.
 */
export const openaiIds = [
  "gpt-6.2-astra",
  "gpt-6.2-sol",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
];

export const OpenAIModel = Schema.Literals(openaiIds);

/** Only the newest Claude models are offered; older catalog models are intentionally excluded. */
const anthropicIds = [
  "claude-opus-5-5",
  "claude-fable-5-2",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

export const AnthropicModel = Schema.Literals(anthropicIds);

export const SessionModel = Schema.Union([OpenAIModel, AnthropicModel]);
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

/** Call only after validating against SessionModel. */
export const modelProvider = (model: string) =>
  model.startsWith("claude-") ? "anthropic" : "openai";

/** Pi's thinking levels; providers clamp unsupported levels to the nearest supported one. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingLevel = Schema.Literals(THINKING_LEVELS);
export const DEFAULT_THINKING_LEVEL = "medium";

/** Session speeds (model-capabilities.ts): Fast and Ultrafast are ChatGPT service tiers. */
export const Speed = Schema.Literals(SPEEDS);

export type Speed = typeof Speed.Type;

export const DEFAULT_SPEED: Speed = "standard";

/** Sessions switch to the other subscription when theirs runs out unless the owner turns it off. */
export const DEFAULT_AUTO_FALLBACK = true;

/**
 * Owner-chosen defaults for new conversations. Each field is optional so one setting can change
 * alone; `null` clears that setting back to the built-in default.
 */
export const DefaultModelSetting = Schema.Struct({
  model: Schema.optional(Schema.NullOr(SessionModel)),
  thinkingLevel: Schema.optional(Schema.NullOr(ThinkingLevel)),
  speed: Schema.optional(Schema.NullOr(Speed)),
  autoFallback: Schema.optional(Schema.NullOr(Schema.Boolean)),
}).check(
  Schema.makeFilter((setting) =>
    Object.values(setting).some((value) => value !== undefined)
      ? undefined
      : "Expected model, thinkingLevel, speed or autoFallback",
  ),
);

/** Per-session changes from the composer; each applies from the next model request. */
export const SessionSettings = Schema.Struct({
  model: Schema.optional(SessionModel),
  thinkingLevel: Schema.optional(ThinkingLevel),
  speed: Schema.optional(Speed),
  autoFallback: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((settings) =>
    Object.values(settings).some((value) => value !== undefined)
      ? undefined
      : "Expected model, thinkingLevel, speed or autoFallback",
  ),
);

export const NewSession = Schema.Struct({
  model: Schema.optional(SessionModel),
  thinkingLevel: Schema.optional(ThinkingLevel),
  speed: Schema.optional(Speed),
  autoFallback: Schema.optional(Schema.Boolean),
  workspace: Schema.optional(WorkspaceInput),
  /** Start the session in this existing workspace instead of a new one. */
  workspaceId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
});

export const ChildMessage = Schema.Struct({
  content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export const ChildRequest = Schema.Struct({
  ...ChildMessage.fields,
  model: Schema.optional(SessionModel),
});
