import type { HistoryPage, Snapshot } from "../../../src/transcript";

type View = typeof Snapshot.Type;

/**
 * Folds a live window update into what the browser already holds. The server's window drops its oldest
 * entries as a long turn grows, and older pages are fetched on scroll; both stay as long as the new window
 * continues right after an entry already held. Otherwise, as after a reconnect gap, the new window starts over.
 */
export function extendTranscript(held: View | null, next: View): View {
  if (!held || next.before === undefined) return next;

  const at = held.entries.findIndex((entry) => entry.id === next.before);

  if (at < 0) return next;

  const entries = [...held.entries.slice(0, at + 1), ...next.entries];
  const { before: _, ...rest } = next;

  return held.before === undefined
    ? { ...rest, entries }
    : { ...rest, entries, before: held.before };
}

/** Prepends an older page fetched through `through`, unless the transcript moved on meanwhile. */
export function prependHistory(held: View, through: number, page: typeof HistoryPage.Type): View {
  if (held.before !== through) return held;

  const entries = [...page.entries, ...held.entries];
  const { before: _, ...rest } = held;

  return page.before === undefined
    ? { ...rest, entries }
    : { ...rest, entries, before: page.before };
}
