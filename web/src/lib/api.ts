import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Block)]),
  toolName: Schema.optional(Schema.String),
});

const Live = Schema.Struct({
  run: Schema.optional(Schema.Struct({})),
  generation: Schema.optional(Schema.Struct({ message: Schema.optional(Message) })),
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

export function liveFromSnapshot(snapshot: typeof Snapshot.Type) {
  return Option.getOrNull(Schema.decodeUnknownOption(Live)(snapshot.docs["pi.live"]));
}

export const Snapshot = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      model: Schema.optional(Schema.Array(Message)),
    }),
  ),
  before: Schema.optional(Schema.String),
  docs: Schema.Record(Schema.String, Schema.Unknown),
});

export const Session = Schema.Struct({ id: Schema.String, model: Schema.String });

export const SavedSession = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  title: Schema.String,
  repository: Schema.String,
  updatedAt: Schema.Number,
});

export type SavedSession = typeof SavedSession.Type;

export type ChatMessage = { id: string; role: string; text: string; toolName?: string };

function messageText(message: typeof Message.Type) {
  return Schema.is(Schema.String)(message.content)
    ? message.content
    : message.content.flatMap((block) => (block.text ? [block.text] : [])).join("\n\n");
}

export function messagesFromSnapshot(snapshot: typeof Snapshot.Type): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const entry of snapshot.entries) {
    for (const [index, message] of (entry.model ?? []).entries()) {
      const text = messageText(message);

      if (text)
        messages.push({
          id: `${entry.id}-${index}`,
          role: message.role,
          text,
          toolName: message.toolName,
        });
    }
  }

  const live = liveFromSnapshot(snapshot);
  const partial = live?.generation?.message;

  if (partial) {
    const text = messageText(partial);

    if (text) messages.push({ id: "live-partial", role: "assistant", text });
  }

  for (const tool of live?.tools ?? []) {
    if (tool.status !== "done")
      messages.push({
        id: `live-tool-${tool.callId}`,
        role: "toolResult",
        toolName: `${tool.name} · ${tool.status}`,
        text: tool.output ?? "Running…",
      });
  }

  return messages;
}

export type ApiBody = {
  content?: string;
  requestId?: string;
  model?: string;
  workspace?: { repository: string };
};

export async function request(path: string, token: string, body?: ApiBody, signal?: AbortSignal) {
  const headers = new Headers({ Authorization: `Bearer ${token}` });

  if (body) headers.set("Content-Type", "application/json");

  const response = await fetch(`/api${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    credentials: "same-origin",
    redirect: "error",
  });

  const text = await response.text();

  if (response.ok && !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The API did not return JSON. Check that /api routes to the pi-hard Worker.");
  }

  if (!response.ok) {
    const error = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
    )(text);

    throw new Error(
      Option.isSome(error)
        ? error.value.error
        : `Request failed (${response.status}). Check your connection and API token.`,
    );
  }

  return text;
}

export function readSessions(value: string): readonly SavedSession[] {
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(SavedSession)))(
    value,
  );

  return Option.getOrElse(result, () => []);
}
