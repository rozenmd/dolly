import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Predicate from "effect/Predicate";
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

/** Entries read per page while indexing prompts. */
const INDEX_PAGE = 200;

/** Raw prompt and reply text kept per indexed turn: enough for the rail's card, which clamps further. */
const INDEX_PROMPT_CHARS = 2000;
const INDEX_REPLY_CHARS = 1200;

/** One prompt in a session, with the opening of its answer: a rail mark for a turn the browser hasn't loaded. */
export type IndexedPrompt = {
  /** The turn's id in the browser: `${entryId}-${messageIndex}`. */
  id: string;
  text: string;
  at?: number;
  images?: number;
  reply?: string;
};

type IndexMessage = NonNullable<EntryRecord["model"]>[number];

function blockText(content: IndexMessage["content"]) {
  if (Predicate.isString(content)) return content;

  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
}

/**
 * Every prompt at or before `through` (a view's `before`), oldest first, so the conversation's rail can reach
 * the start of a session whose older entries the browser hasn't loaded. Reads past `through` only to finish
 * the last indexed turn's answer.
 *
 * Each prompt carries its turn's answer as the browser would show it: the text after the turn's last tool
 * call, unless the turn failed.
 */
export async function promptIndex(
  conversation: Conversation,
  through: number,
): Promise<{ prompts: IndexedPrompt[] }> {
  const prompts: IndexedPrompt[] = [];
  let open: IndexedPrompt | undefined;
  let reply = "";
  let failed = false;
  let cursor: Cursor | undefined;

  const close = () => {
    if (open && reply && !failed) open.reply = reply.slice(0, INDEX_REPLY_CHARS);
    open = undefined;
    reply = "";
    failed = false;
  };

  scan: do {
    const page = await conversation.entries(
      { order: "ascending" },
      INDEX_PAGE,
      cursor,
      BACKGROUND_CONTEXT,
    );

    for (const entry of page.items) {
      for (const [index, message] of (entry.model ?? []).entries()) {
        if (message.role === "user") {
          close();

          if (entry.id > through) break scan;

          const images = Predicate.isString(message.content)
            ? 0
            : message.content.filter((block) => block.type === "image").length;

          const prompt: IndexedPrompt = {
            id: `${entry.id}-${index}`,
            text: blockText(message.content).slice(0, INDEX_PROMPT_CHARS),
            at: message.timestamp,
          };

          if (images) prompt.images = images;
          prompts.push(prompt);
          open = prompt;
          continue;
        }

        if (message.role === "toolResult") {
          reply = "";
          continue;
        }

        if (message.role !== "assistant") continue;

        failed =
          message.stopReason === "error" ||
          message.stopReason === "aborted" ||
          Boolean(message.errorMessage);

        for (const block of message.content) {
          if (block.type === "toolCall") reply = "";
          else if (block.type === "text" && block.text && reply.length < INDEX_REPLY_CHARS)
            reply = reply ? `${reply}\n\n${block.text}` : block.text;
        }
      }
    }

    cursor = page.next;
  } while (cursor);

  close();

  return { prompts };
}
