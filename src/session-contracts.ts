import * as Schema from "effect/Schema";

export const SavedSession = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  title: Schema.String,
  repository: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.optional(Schema.Boolean),
  ref: Schema.optional(Schema.String),
});

export type SavedSession = typeof SavedSession.Type;
