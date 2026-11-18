import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  ConversationWindow,
  Cursor,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";

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

/** Most entries one history page returns. */
export const HISTORY_PAGE_LIMIT = 200;

/**
 * Entries older than a view's window, for a client scrolling back past it: up to `limit` entries at or before
 * `through` (a window's `before`), oldest first, with the ID of the entry just before them when more remain.
 */
export async function historyPage(
  conversation: Conversation,
  through: number,
  limit: number,
): Promise<{ entries: EntryRecord[]; before?: EntryId }> {
  // SAFETY: entry IDs are plain integers on the wire (a view's `before`); maxEntryId only bounds this
  // conversation's fork-aware scan, so any integer selects at most its own entries.
  const maxEntryId = through as EntryId;

  const page = await conversation.entries(
    { order: "descending", maxEntryId },
    limit + 1,
    undefined,
    BACKGROUND_CONTEXT,
  );

  const newest = page.items.slice(0, limit);
  const next = page.items[limit];

  const entries = newest.reverse();

  return next ? { entries, before: next.id } : { entries };
}
