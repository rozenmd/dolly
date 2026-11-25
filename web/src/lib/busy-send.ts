/**
 * What sending does while a run is working. Enter (and the send button) does the chosen action;
 * ⌘/Ctrl+Enter does the other one, so both always have a key. "queue" holds the message until the
 * run finishes and delivers it as the next turn; "steer" folds it into the running turn at its
 * next step boundary (at once while the model is only thinking).
 */
export type BusySend = "queue" | "steer";

const KEY = "dolly-busy-send";
const CHANGED = "dolly-busy-send-changed";

export function readBusySend(): BusySend {
  try {
    return localStorage.getItem(KEY) === "steer" ? "steer" : "queue";
  } catch {
    return "queue";
  }
}

export function saveBusySend(value: BusySend) {
  try {
    // The default's absence is its stored form.
    if (value === "queue") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  } catch {
    // Private mode or storage disabled: the choice lasts this page only.
  }

  window.dispatchEvent(new Event(CHANGED));
}

/** Follow changes made in this tab and in others. */
export function onBusySendChanged(listener: (value: BusySend) => void) {
  const local = () => listener(readBusySend());

  const other = (event: StorageEvent) => {
    if (event.key === KEY) listener(readBusySend());
  };

  window.addEventListener(CHANGED, local);
  window.addEventListener("storage", other);

  return () => {
    window.removeEventListener(CHANGED, local);
    window.removeEventListener("storage", other);
  };
}

export const otherBusySend = (value: BusySend): BusySend => (value === "queue" ? "steer" : "queue");

/** The modifier glyph for ⌘/Ctrl+Enter on this platform. */
export function modEnterGlyph() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘↵"
    : "Ctrl+↵";
}
