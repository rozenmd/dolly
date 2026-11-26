import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { lastReply } from "./child-report";
import { redact } from "./diagnostics";

/**
 * Who a session's next move waits on, read when it is listed: CI (a pr_checks or workflow_run
 * wait), another session (a session_turn wait), a scheduled prompt, or else the owner, because
 * nothing will wake the session by itself. Read live rather than saved with the status: a wait
 * or schedule can end without an answered run (a delivered prompt whose run fails, a cancel),
 * and Pi's afterRun never runs after a failure or an abort.
 */
export type WaitingOn = "ci" | "session" | "schedule" | "owner";

/** What may wake a session by itself: its wait (ci-wait.ts) and scheduled prompts (schedule.ts). */
export type PendingWork = { wait?: "ci" | "session_turn" | undefined; scheduled: number };

export function waitingOn(pending: PendingWork): WaitingOn {
  if (pending.wait === "ci") return "ci";

  if (pending.wait === "session_turn") return "session";

  return pending.scheduled > 0 ? "schedule" : "owner";
}

/** One line per session, saved when each answered run ends, so a listing can say where it stands. */
export type SessionStatus = { text: string; at: number };

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

/** Save a session's status after an answered run: its final reply's first sentence. No model call. */
export async function recordSessionStatus(
  harness: Harness,
  storage: DurableObjectStorage,
  conversationId: ConversationId,
  secrets: readonly string[],
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

  const status: SessionStatus = {
    text: statusText(lastReply([...page.items].reverse()), secrets),
    at: now,
  };

  await storage.put(sessionStatusKey(conversationId), status);
}
