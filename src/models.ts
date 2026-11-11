import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import * as Schema from "effect/Schema";

/** Pi's pinned subscription-provider catalog owns the accepted model identifiers. */
export const CodexModel = Schema.Literals(
  openaiCodexProvider()
    .getModels()
    .map((model) => model.id),
);

export const NewSession = Schema.Struct({ model: Schema.optional(CodexModel) });
