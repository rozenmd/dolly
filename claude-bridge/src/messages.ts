/**
 * The Anthropic Messages API request the bridge accepts, and how a slice of its conversation
 * becomes one Claude Agent SDK prompt.
 *
 * Ported from Open Session's anthropic-bridge.ts (MIT, see third_party/opensession/LICENSE):
 * history replays as flat text, tool results unwrap to their raw output so the model reads them
 * as the natural outcome of its forwarded call, and only the current user turn's images reach the
 * SDK as real content blocks. Earlier images leave a placeholder and are never re-sent.
 */
import { z } from "zod";

/** A JSON value, as the model writes tool arguments. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One JSON object: a tool call's arguments, or an event's payload. */
export type JsonObject = { [key: string]: JsonValue };

export const ToolArguments: z.ZodType<JsonObject> = z.record(z.string(), z.json());

const Text = z.object({ type: z.literal("text"), text: z.string() });

const Image = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({
      type: z.literal("base64"),
      media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      data: z.string(),
    }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
});

const ToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: ToolArguments.optional(),
});

const ToolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.union([Text, Image]))]).optional(),
  is_error: z.boolean().optional(),
});

/**
 * Blocks the bridge never forwards, such as thinking: its signatures cannot round-trip through a
 * replay. Tried last, so it only takes what the blocks above don't.
 */
const Other = z.object({ type: z.string() }).transform(() => ({ type: "other" as const }));

export const ContentBlock = z.union([Text, Image, ToolUse, ToolResult, Other]);

export type ContentBlock = z.infer<typeof ContentBlock>;

export type ImageBlock = z.infer<typeof Image>;

export const Message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentBlock)]),
});

export type Message = z.infer<typeof Message>;

/** A tool's JSON Schema, as far as the bridge reads it to shape what the model emits. */
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

export const JsonSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z.looseObject({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    description: z.string().optional(),
    enum: z.array(z.string()).optional().catch(undefined),
    properties: z.record(z.string(), JsonSchema).optional(),
    required: z.array(z.string()).optional(),
    items: JsonSchema.optional().catch(undefined),
  }),
);

export const Tool = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Kept as sent: tool-schema.ts converts it for the SDK. */
  input_schema: ToolArguments.optional(),
});

export type Tool = z.infer<typeof Tool>;

export const MessagesRequest = z.object({
  model: z.string().default(""),
  messages: z.array(Message).min(1),
  system: z.union([z.string(), z.array(z.looseObject({ text: z.string() }))]).optional(),
  tools: z.array(Tool).default([]),
  max_tokens: z.number().optional(),
  stream: z.boolean().default(false),
  thinking: z
    .union([
      z.object({ type: z.literal("disabled") }),
      z.object({ type: z.literal("adaptive") }),
      z.object({ type: z.literal("enabled"), budget_tokens: z.number() }),
    ])
    .optional()
    .catch(undefined),
  output_config: z
    .object({ effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional() })
    .optional()
    .catch(undefined),
});

export type MessagesRequest = z.infer<typeof MessagesRequest>;

/** The request's system prompt as one string. */
export function systemText(system: MessagesRequest["system"]) {
  if (system === undefined) return "";

  if (Array.isArray(system))
    return system
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n\n");

  return system;
}

/** What a replay leaves where an earlier turn carried an image. */
export const PRIOR_IMAGE_PLACEHOLDER = "[image previously attached]";

/** Text for a current turn whose only content is an image: an empty prompt reads as no turn. */
export const IMAGE_ONLY_PROMPT = "(see the attached image)";

/** Per-turn image ceiling, newest kept. */
export const MAX_TURN_IMAGES = 8;

/** Flatten one message to plain text; with `markImages`, images leave a placeholder. */
export function flattenMessageText(content: Message["content"], markImages = false) {
  if (!Array.isArray(content)) return content;
  const parts: string[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "image" && markImages) parts.push(PRIOR_IMAGE_PLACEHOLDER);
    else if (block.type === "tool_use")
      parts.push(`[called tool ${block.name} with ${JSON.stringify(block.input ?? {})}]`);
    else if (block.type === "tool_result") {
      if (!Array.isArray(block.content)) {
        if (block.content) parts.push(block.content);
        continue;
      }

      for (const inner of block.content) {
        if (inner.type === "text" && inner.text) parts.push(inner.text);
        else if (inner.type === "image" && markImages) parts.push(PRIOR_IMAGE_PLACEHOLDER);
      }
    }
  }

  return parts.join("\n");
}

/** Flat-text replay of a conversation. */
export function replayConversation(messages: readonly Message[], markImages = false) {
  const turns: string[] = [];

  for (const message of messages) {
    const text = flattenMessageText(message.content, markImages).trim();

    if (!text) continue;
    turns.push(message.role === "assistant" ? `[Your previous reply]\n${text}` : text);
  }

  return turns.join("\n\n");
}

/** Where the current user turn starts: just after the last assistant message. */
export function currentTurnStart(messages: readonly Message[]) {
  for (let index = messages.length - 1; index >= 0; index--)
    if (messages[index]?.role === "assistant") return index + 1;

  return 0;
}

/** Image blocks in user messages (tool result images included), newest kept. */
export function turnImages(messages: readonly Message[]) {
  const images: ImageBlock[] = [];

  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      if (block.type === "image") images.push(block);
      else if (block.type === "tool_result" && Array.isArray(block.content))
        for (const inner of block.content) if (inner.type === "image") images.push(inner);
    }
  }

  return images.slice(-MAX_TURN_IMAGES);
}

/** One SDK turn built from a delivered slice of the conversation. */
export type SdkTurn = {
  /** Replayed history before the current turn, images as placeholders. */
  history: string;
  /** The current user turn's text. */
  current: string;
  /** The current user turn's images, delivered as real content blocks. */
  images: ImageBlock[];
};

/**
 * The SDK turn for a request: the whole conversation for a fresh SDK session, else only what the
 * SDK session has not seen yet (`seen` messages).
 */
export function sdkTurn(messages: readonly Message[], seen = 0): SdkTurn {
  const delivered = messages.slice(seen);
  const from = Math.min(delivered.length, Math.max(0, currentTurnStart(messages) - seen));
  const current = delivered.slice(from);

  return {
    history: replayConversation(delivered.slice(0, from), true),
    current: replayConversation(current),
    images: turnImages(current),
  };
}

/** The whole turn as one flat-text prompt. */
export function sdkTurnText(turn: SdkTurn) {
  return [turn.history, turn.current].filter(Boolean).join("\n\n");
}

/** Structured user content for a turn carrying images, or null for a plain-text turn. */
export function sdkTurnContent(turn: SdkTurn) {
  if (turn.images.length === 0) return null;
  const content: Array<z.infer<typeof Text> | ImageBlock> = [];

  if (turn.history) content.push({ type: "text", text: turn.history });
  content.push(...turn.images, { type: "text", text: turn.current.trim() || IMAGE_ONLY_PROMPT });

  return content;
}
