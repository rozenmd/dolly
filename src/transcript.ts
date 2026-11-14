import * as Schema from "effect/Schema";

export const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  data: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
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
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});

export const RunFailure = Schema.Struct({
  reason: Schema.String,
  detail: Schema.optional(Schema.String),
  first: Schema.optional(Schema.Number),
});

export const Live = Schema.Struct({
  run: Schema.optional(Schema.Struct({})),
  runFailure: Schema.optional(RunFailure),
  generation: Schema.optional(
    Schema.Struct({
      attempt: Schema.optional(Schema.Number),
      message: Schema.optional(Message),
      retry: Schema.optional(Schema.Struct({ at: Schema.Number, error: Schema.String })),
    }),
  ),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        name: Schema.String,
        status: Schema.String,
        output: Schema.optional(Schema.String),
      }),
    ),
  ),
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
