import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import * as Schema from "effect/Schema";
import { WorkspaceInput } from "./workspace";

/** Pi's pinned subscription-provider catalog owns the accepted model identifiers. */
export const CodexModel = Schema.Literals(
  openaiCodexProvider()
    .getModels()
    .map((model) => model.id),
);

/** Only the newest Claude models are offered; older catalog models are intentionally excluded. */
const anthropicIds = [
  "claude-opus-5-5",
  "claude-fable-5-2",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

export const AnthropicModel = Schema.Literals(anthropicIds);

export const SessionModel = Schema.Union([CodexModel, AnthropicModel]);
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

/** Call only after validating against SessionModel. Existing Codex IDs keep their provider. */
export const modelProvider = (model: string) =>
  model.startsWith("claude-") ? "anthropic" : "openai-codex";

export const NewSession = Schema.Struct({
  model: Schema.optional(SessionModel),
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
