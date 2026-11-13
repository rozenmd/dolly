import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import * as Schema from "effect/Schema";
import { WorkspaceInput } from "./workspace";

/** Pi's pinned subscription-provider catalog owns the accepted model identifiers. */
export const CodexModel = Schema.Literals(
  openaiCodexProvider()
    .getModels()
    .map((model) => model.id),
);

export const AnthropicModel = Schema.Literals(
  anthropicProvider()
    .getModels()
    .map((model) => model.id),
);

export const SessionModel = Schema.Union([CodexModel, AnthropicModel]);
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

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
