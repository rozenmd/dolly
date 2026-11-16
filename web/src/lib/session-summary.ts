import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The session summary card's state, modelled on Open Session's workspace summary.
 *
 * Whether the card is up is one browser-wide preference rather than a setting
 * per session: the card is a standing view that follows you from one session to
 * the next and survives a reload. Anyone who has not closed it sees it open.
 * Another tab's change arrives as a storage event.
 *
 * The card only stands open on its own where the conversation pane has room to
 * give it a gutter. On a narrower pane it would cover the transcript it
 * summarises, so there it opens from the header button as an overlay that
 * leaves on the next click outside, without touching the stored preference.
 */
export const summaryOpenKey = "dolly.summary.open.v1";

/** The narrowest conversation pane that keeps the card beside the transcript. */
export const summaryRoomWidth = 960;

const listeners = new Set<() => void>();
let pinned: boolean | null = null;

function readPinned() {
  try {
    return localStorage.getItem(summaryOpenKey) !== "false";
  } catch {
    // Unreadable storage: the card starts open, as it does for anyone new.
    return true;
  }
}

function current() {
  pinned ??= readPinned();

  return pinned;
}

function publish(next: boolean) {
  pinned = next;

  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== summaryOpenKey && event.key !== null) return;
  publish(readPinned());
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);

  return () => {
    listeners.delete(listener);

    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

function setPinned(open: boolean) {
  if (current() === open) return;

  try {
    localStorage.setItem(summaryOpenKey, String(open));
  } catch {
    // Private mode or a full quota: the in-memory preference still works.
  }

  publish(open);
}

/** Whether an element is at least `width` pixels wide, following resizes. */
function useWideEnough(element: HTMLElement | null, width: number) {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    if (!element) return;
    const measure = () => setWide(element.getBoundingClientRect().width >= width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [element, width]);

  return wide;
}

export type SessionSummary = {
  open: boolean;
  /** The card stands beside the transcript rather than over it. */
  standing: boolean;
  setOpen: (open: boolean) => void;
  /** Attach to the conversation pane the card hangs in. */
  paneRef: (element: HTMLElement | null) => void;
};

/**
 * The conversation pane's width, not the window's, decides whether there is
 * room for the card: the sidebar eats into it.
 */
export function useSessionSummary(): SessionSummary {
  const [pane, paneRef] = useState<HTMLElement | null>(null);
  // Server rendering and hydration see the card shut; the stored preference
  // arrives on the client's first render after hydration.
  const preference = useSyncExternalStore(subscribe, current, () => false);
  const room = useWideEnough(pane, summaryRoomWidth);
  // A card opened by hand on a narrow pane. Held apart from the preference so
  // an overlay opened here does not become every wider window's setting.
  const [transient, setTransient] = useState(false);

  // Back at a width that holds the card, the preference takes over, and
  // narrowing again starts shut rather than reviving an old overlay.
  useEffect(() => {
    if (room) setTransient(false);
  }, [room]);

  return {
    open: room ? preference : transient,
    standing: room,
    setOpen: (open) => (room ? setPinned(open) : setTransient(open)),
    paneRef,
  };
}
