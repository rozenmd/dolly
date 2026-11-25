import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { redact } from "./diagnostics";
import { Live, Message } from "./transcript";
import { stepDetail, stepSummary, type ToolCall } from "./tool-activity";

/** Newest entries read for a running session's latest saved tool call. */
const TAIL = 4;

/** The last tool call in a message's content, which may be a live partial. */
function lastToolCall(message: typeof Message.Type | undefined): ToolCall | undefined {
  if (!message || Schema.is(Schema.String)(message.content)) return undefined;

  return message.content.findLast((block) => block.type === "toolCall" && block.name);
}

const decodeMessage = Schema.decodeUnknownOption(Message);
const decodeLive = Schema.decodeUnknownOption(Live);

/** The newest saved tool call of the current turn: a user message ends the search. */
async function savedToolCall(harness: Harness, id: ConversationId) {
  const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);

  if (!conversation) return undefined;

  const page = await conversation.entries(
    { order: "descending" },
    TAIL,
    undefined,
    BACKGROUND_CONTEXT,
  );

  for (const entry of page.items) {
    for (const message of [...(entry.model ?? [])].reverse()) {
      if (message.role === "user") return undefined;

      if (message.role !== "assistant") continue;

      const call = lastToolCall(Option.getOrUndefined(decodeMessage(message)));

      if (call) return call;
    }
  }

  return undefined;
}

/**
 * What a running session is doing now, worded as its step in the transcript ("Editing
 * checkout.tsx", "Running pnpm test"): the tool call it is issuing, else its newest saved one.
 * Reads the live doc and a few newest entries, never the whole transcript. Arguments are redacted
 * before they are summarised, like titles, so a secret cut at the limit still matches.
 */
export async function sessionActivity(
  harness: Harness,
  id: ConversationId,
  secrets: readonly string[],
): Promise<string | undefined> {
  const live = Option.getOrUndefined(
    decodeLive(await harness.snapshot(LiveDoc, id, BACKGROUND_CONTEXT)),
  );

  const tool = live?.tools?.at(-1);

  const call =
    lastToolCall(live?.generation?.message) ??
    (await savedToolCall(harness, id)) ??
    (tool && { name: tool.name });

  if (!call?.name) return undefined;

  const { detail, file } = stepDetail(call);

  return stepSummary({
    name: call.name,
    detail: redact(detail, secrets),
    file: file && { path: redact(file.path, secrets) },
  });
}
