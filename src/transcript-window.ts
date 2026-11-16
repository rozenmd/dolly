import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationWindow, Cursor, EntryId } from "@earendil-works/pi-durable";

/** Pi's default window size: a fresh view holds the newest 50 entries. */
const DEFAULT_ENTRIES = 50;

/** Furthest back a view reaches for the latest prompt, bounding each snapshot's size. */
const PROMPT_SCAN_LIMIT = 250;

/**
 * Pi starts a view at the newest 50 entries, so a long tool-using turn pushes its own
 * prompt out of a freshly opened window. Start the window at the latest user prompt
 * instead, holding at least every entry since it, while it is within the scan limit.
 * Appends keep the prompt until the window doubles; a reload then reaches it again.
 */
export async function promptWindow(
  conversation: Conversation,
): Promise<ConversationWindow | undefined> {
  let cursor: Cursor | undefined;
  let scanned = 0;

  do {
    const page = await conversation.entries(
      { order: "descending" },
      DEFAULT_ENTRIES,
      cursor,
      BACKGROUND_CONTEXT,
    );

    for (const entry of page.items) {
      scanned += 1;

      if (scanned > PROMPT_SCAN_LIMIT) return undefined;

      if (entry.model?.some((message) => message.role === "user"))
        return scanned <= DEFAULT_ENTRIES ? undefined : window(entry.id, scanned);
    }

    cursor = page.next;
  } while (cursor);

  return undefined;
}

function window(from: EntryId, entries: number): ConversationWindow {
  return { from, min: entries, max: entries * 2 };
}
