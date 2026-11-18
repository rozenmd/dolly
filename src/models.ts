import * as Schema from "effect/Schema";
import { WorkspaceInput } from "./workspace";

/**
 * Models that Sign in with ChatGPT tokens may call on api.openai.com. Pi's OpenAI catalog owns
 * their definitions; this list matches the models other connected agents offer.
 */
export const openaiIds = [
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

/** Owner-chosen default for new conversations; `null` clears it back to the built-in defaults. */
export const DefaultModelSetting = Schema.Struct({ model: Schema.NullOr(SessionModel) });

/** Call only after validating against SessionModel. */
export const modelProvider = (model: string) =>
  model.startsWith("claude-") ? "anthropic" : "openai";

/** Pi's thinking levels; providers clamp unsupported levels to the nearest supported one. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingLevel = Schema.Literals(THINKING_LEVELS);
export const DEFAULT_THINKING_LEVEL = "medium";

export const SessionSettings = Schema.Struct({ thinkingLevel: ThinkingLevel });

export const NewSession = Schema.Struct({
  model: Schema.optional(SessionModel),
  thinkingLevel: Schema.optional(ThinkingLevel),
  workspace: Schema.optional(WorkspaceInput),
});

export const ChildMessage = Schema.Struct({
  content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export const ChildRequest = Schema.Struct({
  ...ChildMessage.fields,
  model: Schema.optional(SessionModel),
});
