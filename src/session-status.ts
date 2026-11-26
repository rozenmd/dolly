import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { lastReply } from "./child-report";
import { redact } from "./diagnostics";

/**
 * Who a session's next move waits on, as Dolly knows it when a run ends: CI (a pr_checks or
 * workflow_run wait), another session (a session_turn wait), a scheduled prompt, or else the
 * owner, because nothing will wake the session by itself.
 */
export type WaitingOn = "ci" | "session" | "schedule" | "owner";

/** One line per session, saved when each run ends, so a listing can say where each stands. */
export type SessionStatus = { text: string; waitingOn: WaitingOn; at: number };

export const sessionStatusKey = (conversationId: ConversationId) =>
  `session-status:${conversationId}`;

/** Where a status line is cut when its first sentence runs longer. */
export const STATUS_CHARS = 140;

/** Newest entries scanned for the run's final assistant message. */
const STATUS_SCAN_ENTRIES = 20;

/** The first sentence of a reply, redacted, within {@link STATUS_CHARS}. */
export function statusText(reply: string, secrets: readonly string[]) {
  // Redact before cutting: a secret cut at the limit would no longer match.
  const line = redact(reply, secrets).trim().split("\n")[0]?.trim() ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;

  return sentence.length > STATUS_CHARS ? `${sentence.slice(0, STATUS_CHARS - 1)}…` : sentence;
}

/**
 * Save a session's status after a run: its final reply's first sentence and what it waits on,
 * from the wait and schedule state ci-wait.ts and schedule.ts already keep. No model call.
 */
export async function recordSessionStatus(
  harness: Harness,
  storage: DurableObjectStorage,
  conversationId: ConversationId,
  secrets: readonly string[],
  pending: { wait?: "ci" | "session_turn" | undefined; scheduled: number },
  now: number = Date.now(),
) {
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);

  if (!conversation) return;

  const page = await conversation.entries(
    { order: "descending" },
    STATUS_SCAN_ENTRIES,
    undefined,
    BACKGROUND_CONTEXT,
  );

  const waitingOn: WaitingOn =
    pending.wait === "ci"
      ? "ci"
      : pending.wait === "session_turn"
        ? "session"
        : pending.scheduled > 0
          ? "schedule"
          : "owner";

  const status: SessionStatus = {
    text: statusText(lastReply([...page.items].reverse()), secrets),
    waitingOn,
    at: now,
  };

  await storage.put(sessionStatusKey(conversationId), status);
}
