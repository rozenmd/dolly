import * as Schema from "effect/Schema";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * The right side panel's state, modelled on Open Session's side panel.
 *
 * Whether the panel is open belongs to each session: one session can sit with
 * the panel closed, another with it open beside the conversation. A session
 * nobody has opened or closed it in starts closed. The width is one
 * browser-wide choice set by dragging the panel's left edge. Both are kept in
 * localStorage, and another browser tab's write arrives as a storage event.
 *
 * It is a module store rather than component state so that every browser tab,
 * and every component that renders the panel or its toggle, sees one copy.
 */
export const panelViewsKey = "dolly.panel.views.v1";
export const panelWidthKey = "dolly.panel.width.v1";

/** Keep the stored map to the sessions someone has touched recently. */
const maxStoredSessions = 300;
export const minPanelWidth = 320;

/** The panel may grow until the conversation keeps this much room. */
const reservedWidth = 620;

/** How long the panel takes to slide in: the CSS transition plus a margin. */
const enterMs = 330;

type State = {
  views: PanelViews;
  /** The session whose panel an action just opened, so it slides in rather
   *  than appears. A panel shown by switching sessions does not. */
  opening: string | null;
};

let state: State | null = null;

/** Server rendering and hydration see every panel closed; the stored state
 *  arrives on the client's first render after hydration. */
const serverState: State = { views: {}, opening: null };
const listeners = new Set<() => void>();

const StoredViews = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean));

type PanelViews = typeof StoredViews.Type;

function readViews(): PanelViews {
  try {
    return Schema.decodeUnknownSync(StoredViews)(localStorage.getItem(panelViewsKey) ?? "{}");
  } catch {
    // Unreadable or malformed storage: every panel starts closed.
    return {};
  }
}

function current(): State {
  state ??= { views: readViews(), opening: null };

  return state;
}

function publish(next: State) {
  state = next;

  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== panelViewsKey && event.key !== null) return;
  publish({ views: readViews(), opening: null });
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);

  return () => {
    listeners.delete(listener);

    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}

/** Write a session's open state, moving it to the newest end of the stored map. */
export function setPanelOpen(key: string, open: boolean) {
  const prev = current();

  if (prev.views[key] === open) return;
  const views = { ...prev.views };
  delete views[key];
  views[key] = open;
  const kept = Object.fromEntries(Object.entries(views).slice(-maxStoredSessions));

  try {
    localStorage.setItem(panelViewsKey, JSON.stringify(kept));
  } catch {
    // Private mode or a full quota: the in-memory state still works.
  }

  publish({ views: kept, opening: open ? key : prev.opening === key ? null : prev.opening });
}

function finishOpening(key: string) {
  const prev = current();

  if (prev.opening === key) publish({ ...prev, opening: null });
}

function maxWidth() {
  return Math.max(480, Math.round(window.innerWidth - reservedWidth));
}

function storedWidth() {
  try {
    const stored = Number(localStorage.getItem(panelWidthKey));

    return stored >= minPanelWidth ? stored : 0;
  } catch {
    return 0;
  }
}

export type SidePanel = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** An action just opened the panel: slide it in. */
  entering: boolean;
  /** The dragged width in pixels, or 0 for the stylesheet's default. */
  width: number;
  /** Start dragging the panel's left edge. */
  startResize: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Step the width from the keyboard; the handle is a focusable separator. */
  nudge: (delta: number) => void;
};

export function useSidePanel(key: string): SidePanel {
  const snapshot = useSyncExternalStore(subscribe, current, () => serverState);
  const open = snapshot.views[key] ?? false;
  const entering = snapshot.opening === key;
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);

  // localStorage is read after mount so server rendering and hydration agree.
  useEffect(() => {
    const stored = storedWidth();
    widthRef.current = stored;
    setWidth(stored);
  }, []);

  useEffect(() => {
    if (!entering) return;
    const timer = window.setTimeout(() => finishOpening(key), enterMs);

    return () => window.clearTimeout(timer);
  }, [entering, key]);

  function commit(next: number) {
    const clamped = Math.min(maxWidth(), Math.max(minPanelWidth, Math.round(next)));
    widthRef.current = clamped;
    setWidth(clamped);

    return clamped;
  }

  function save() {
    try {
      localStorage.setItem(panelWidthKey, String(widthRef.current));
    } catch {
      // Keep the width for this page only.
    }
  }

  function startResize(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();

    // The handle sits on the panel's left edge, so the width is the pointer's
    // distance from the panel's right side.
    const right =
      event.currentTarget.parentElement?.getBoundingClientRect().right ?? window.innerWidth;

    document.body.classList.add("resizing-panel");
    const onMove = (move: PointerEvent) => commit(right - move.clientX);

    const onUp = () => {
      document.body.classList.remove("resizing-panel");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      save();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function nudge(delta: number) {
    const base =
      widthRef.current ||
      document.querySelector(".side-panel")?.getBoundingClientRect().width ||
      minPanelWidth;

    commit(base + delta);
    save();
  }

  return {
    open,
    setOpen: (next) => setPanelOpen(key, next),
    entering,
    width,
    startResize,
    nudge,
  };
}
