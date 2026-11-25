import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type ConversationId,
  type Cursor,
  type Harness,
  type LiveState,
} from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { redact } from "./diagnostics";
import { Live, Message } from "./transcript";
import { stepDetail, stepSummary, type ToolCall } from "./tool-activity";

/** Newest entries read at a time for a running session's latest saved tool call. */
const TAIL = 4;

/**
 * Entries read at most: a round's results land after its assistant entry, one per call, so a
 * wide round between generations needs more than one page, but never the whole transcript.
 */
const MAX_SCAN = 32;

type LiveView = typeof Live.Type;

/** The last tool call in a message's content, which may be a live partial. */
function lastToolCall(message: typeof Message.Type | undefined): ToolCall | undefined {
  if (!message || Schema.is(Schema.String)(message.content)) return undefined;

  return message.content.findLast((block) => block.type === "toolCall" && block.name);
}

/** The call a message issued under `callId`, if it did. */
function toolCallById(message: typeof Message.Type, callId: string): ToolCall | undefined {
  if (Schema.is(Schema.String)(message.content)) return undefined;

  return message.content.find(
    (block) => block.type === "toolCall" && block.name && block.id === callId,
  );
}

/** The current round's call still going: the first not done, as a sequential round runs them. */
function currentSlot(live: LiveView | undefined) {
  return live?.tools?.find((tool) => tool.status !== "done") ?? live?.tools?.at(-1);
}

const decodeMessage = Schema.decodeUnknownOption(Message);
const decodeLive = Schema.decodeUnknownOption(Live);

/**
 * The saved call the current round is running, else the newest saved one of the current turn; a
 * user message ends the search. Pages past the results that follow a round's assistant entry, so
 * it stays in reach however many have landed.
 */
async function savedToolCall(harness: Harness, id: ConversationId, live: LiveView | undefined) {
  const conversation = await harness.conversation(id, BACKGROUND_CONTEXT);

  if (!conversation) return undefined;

  const slot = currentSlot(live);

  let cursor: Cursor | undefined;
  let read = 0;

  do {
    const page = await conversation.entries(
      { order: "descending" },
      TAIL + (live?.tools?.length ?? 0),
      cursor,
      BACKGROUND_CONTEXT,
    );

    for (const entry of page.items) {
      for (const message of [...(entry.model ?? [])].reverse()) {
        if (message.role === "user") return undefined;

        if (message.role !== "assistant") continue;

        const decoded = Option.getOrUndefined(decodeMessage(message));

        if (!decoded) continue;

        const call = (slot && toolCallById(decoded, slot.callId)) ?? lastToolCall(decoded);

        if (call) return call;
      }
    }

    read += page.items.length;
    cursor = page.next;
  } while (cursor && read < MAX_SCAN);

  return undefined;
}

/**
 * What the live doc alone says about a session's step, as a comparable key: the call being
 * generated and the round's call still going. It changes when activity may have moved, without
 * reading entries, so the sessions feed can watch it cheaply.
 */
export function liveStepKey(doc: Readonly<LiveState> | undefined): string {
  const live = Option.getOrUndefined(decodeLive(doc));
  const generating = lastToolCall(live?.generation?.message);

  return JSON.stringify([
    generating?.name && stepSummary({ name: generating.name, ...stepDetail(generating) }),
    currentSlot(live)?.callId,
  ]);
}

/**
 * What a running session is doing now, worded as its step in the transcript ("Editing
 * checkout.tsx", "Running pnpm test"): the tool call it is issuing, else the one its round is
 * running, else its newest saved one. Reads the live doc and a few newest entries, never the whole
 * transcript. Arguments are redacted before they are summarised, like titles, so a secret cut at
 * the limit still matches.
 */
export async function sessionActivity(
  harness: Harness,
  id: ConversationId,
  secrets: readonly string[],
): Promise<string | undefined> {
  const live = Option.getOrUndefined(
    decodeLive(await harness.snapshot(LiveDoc, id, BACKGROUND_CONTEXT)),
  );

  const slot = currentSlot(live);

  const call =
    lastToolCall(live?.generation?.message) ??
    (await savedToolCall(harness, id, live)) ??
    (slot && { name: slot.name });

  if (!call?.name) return undefined;

  const { detail, file } = stepDetail(call);

  return stepSummary({
    name: call.name,
    detail: redact(detail, secrets),
    file: file && { path: redact(file.path, secrets) },
  });
}
