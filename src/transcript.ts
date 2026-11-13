import * as Schema from "effect/Schema";

export const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Unknown),
});

export const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Block)]),
  toolName: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  timestamp: Schema.optional(Schema.Number),
});

/** Pi durable record IDs are numbers; provider message/tool IDs remain strings. */
export const Snapshot = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      kind: Schema.String,
      model: Schema.optional(Schema.Array(Message)),
    }),
  ),
  before: Schema.optional(Schema.Number),
  docs: Schema.Record(Schema.String, Schema.Unknown),
});
