import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import * as Schema from "effect/Schema";
import { WorkspaceInput } from "./workspace";

/** Pi's pinned subscription-provider catalog owns the accepted model identifiers. */
export const CodexModel = Schema.Literals(
  openaiCodexProvider()
    .getModels()
    .map((model) => model.id),
);

export const NewSession = Schema.Struct({
  model: Schema.optional(CodexModel),
  workspace: Schema.optional(WorkspaceInput),
});

export const ChildMessage = Schema.Struct({
  content: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export const ChildRequest = Schema.Struct({
  ...ChildMessage.fields,
  model: Schema.optional(CodexModel),
});
