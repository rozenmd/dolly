import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { CheckCircleIcon, PencilIcon } from "@heroicons/react/16/solid";
import type { RailMark, RailOutcome } from "../lib/turn-rail";
import { ago } from "../lib/time";

/**
 * The prompts you sent, as a rail of ticks down the conversation's left edge, after opensession's message
 * rail (tellahq/opensession, MessageRail.tsx). Running the pointer down it previews one turn at a time in a
 * card; clicking jumps there.
 *
 * It indexes prompts, not the document: a turn runs from one line to thousands, so a proportional map would
 * draw verbosity, while what someone scrolling back wants is the question they asked.
 *
 * The rail is one hit target, not one per tick: at 60 prompts a tick is a couple of pixels tall, too small
 * to hover, so pointer Y maps to the nearest prompt and the ticks are decoration. They fan out as a lens
 * around the pointer, so a reader scrubbing the strip can see where in it they are.
 *
 * It is a shortcut, so it stays out of the way: hidden on touch and at phone widths (styles.css), and while
 * the conversation fits on one screen. It stays keyboard operable.
 */

/** Below this there is nothing to navigate. */
const MIN_MARKS = 2;

/** Where the strip sits, and its width; the conversation reserves this gutter (styles.css). */
const RAIL_EDGE = 15;
const RAIL_W = 22;

/**
 * Tick sizes. Each tick is laid out at its largest and scaled down from its left edge, so every size is a
 * transform: no layout on a long rail, and ticks grow toward the column from an edge that never moves.
 */
const TICK_MAX_W = 20;
const TICK_MAX_H = 3;
const TICK_REST_W = 8;
const TICK_REST_H = 2;
const TICK_REST_INK = 0.22;

/** The turn being read: a touch longer, full ink at rest, and a step back while the lens is up. */
const TICK_CURRENT_W = 12;
const TICK_HERE_INK = 0.5;

/** Each tick's share of the growth by its distance from the pointer: a curve, not a wedge. */
const LENS = [1, 0.62, 0.38, 0.22, 0.1];

/** Per-tick delay away from the pointer as the rail wakes, capped so a long rail doesn't lag. */
const STAGGER_MS = 14;
const STAGGER_MAX = 6;

/** Ideal gap between ticks, compressed in long sessions. */
const PITCH = 10;

/** Grab room above the first tick and below the last. */
const STACK_PAD = 10;

/** Room the stack leaves at the conversation's top and bottom. */
const RAIL_MARGIN = 32;

/** Where a jumped-to turn parks below the conversation's top edge. */
const TOP_GAP = 20;

/** A conversation within this much of fitting on one screen has nowhere to jump to. */
const STICK_SLACK = 90;

/** Correction passes after a jump, for content that lays out on the way (images, code). */
const SETTLE_FRAMES = 8;

/** The card waits for intent, and lingers briefly as the pointer leaves. */
const OPEN_DELAY = 220;
const CLOSE_DELAY = 140;

/** Space between the card and the conversation's edges. */
const CARD_EDGE = 8;

function OutcomeIcon({ kind }: { kind: RailOutcome["kind"] }) {
  if (kind === "pr")
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      </svg>
    );

  return kind === "commit" ? <CheckCircleIcon /> : <PencilIcon />;
}

export function TurnRail({
  marks,
  containerRef,
  leaveLatest,
  seeking,
  onSeek,
  now,
}: {
  marks: readonly RailMark[];
  /** The conversation's scroll container. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Moving into history is intent: stop following new output. */
  leaveLatest: () => void;
  /** A mark whose turn is still loading: the rail jumps there once it is in the conversation. */
  seeking?: string;
  /** Asks for a mark's turn to be loaded (the conversation fetches earlier messages), or stops asking. */
  onSeek: (id: string | undefined) => void;
  now: number;
}) {
  const rail = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** The tick being pointed at, or arrowed to: what a jump goes to. */
  const [active, setActive] = useState(0);
  /** The turn the reader is in. */
  const [current, setCurrent] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  /** True for the length of the wake-up ripple, and only then. */
  const [entering, setEntering] = useState(false);
  const [height, setHeight] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  const [cardTop, setCardTop] = useState(0);
  const timer = useRef<number>(undefined);

  const count = marks.length;
  const enabled = count >= MIN_MARKS;
  const hot = hovered || keyboard || open;

  // A streaming turn rebuilds `marks` on every update; the scroll listener reads them through a ref.
  const latest = useRef(marks);

  useEffect(() => {
    latest.current = marks;
  });

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // The ripple runs on arrival only: while scrubbing, a per-tick delay would trail the pointer.
  useEffect(() => {
    if (!entering) return;

    const done = window.setTimeout(() => setEntering(false), STAGGER_MAX * STAGGER_MS + 60);

    return () => window.clearTimeout(done);
  }, [entering]);

  /* Where the rail can sit: the conversation's height, and whether it scrolls at all. */

  function measure() {
    const element = containerRef.current;

    if (!element) return;
    setHeight(element.clientHeight);
    setScrollable(element.scrollHeight > element.clientHeight + STICK_SLACK);
  }

  // After every render: content lands and streams in without resizing the container.
  useEffect(measure);

  useEffect(() => {
    const element = containerRef.current;

    if (!element || !enabled) return;

    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [containerRef, enabled]);

  /* Geometry. */

  const available = Math.max(0, height - RAIL_MARGIN * 2);
  const pitch = count > 1 ? Math.min(PITCH, available / (count - 1)) : 0;
  const tickY = (index: number) => STACK_PAD + index * pitch;
  const boxH = pitch * Math.max(0, count - 1) + STACK_PAD * 2;

  function indexAt(clientY: number) {
    const element = rail.current;

    if (!element || pitch <= 0) return 0;

    const y = clientY - element.getBoundingClientRect().top - STACK_PAD;

    return Math.max(0, Math.min(count - 1, Math.round(y / pitch)));
  }

  /* Which turn the reader is in: the last whose top is above the conversation's top edge. */

  useEffect(() => {
    const element = containerRef.current;

    if (!element || !enabled) return;

    function track() {
      if (!element) return;

      const order = new Map(latest.current.map((mark, index) => [mark.id, index]));
      const edge = element.getBoundingClientRect().top + TOP_GAP + 4;
      let index = 0;

      for (const node of element.querySelectorAll<HTMLElement>("[data-turn]")) {
        if (node.getBoundingClientRect().top > edge) break;
        index = order.get(node.dataset.turn ?? "") ?? index;
      }

      // At the live edge the newest turn is what's being read, even when it starts below the top edge.
      const end = element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
      setCurrent(end ? latest.current.length - 1 : index);
    }

    // A decoration that can afford to be late: throttled off the scroll path.
    let pending: number | undefined;

    const onScroll = () => {
      if (pending !== undefined) return;

      pending = window.setTimeout(() => {
        pending = undefined;
        track();
      }, 100);
    };

    track();
    element.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      element.removeEventListener("scroll", onScroll);
      window.clearTimeout(pending);
    };
  }, [containerRef, enabled, count]);

  /* Jumping: instant, then corrected while content above the turn finishes laying out. */

  function turnNode(id: string) {
    return containerRef.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(id)}"]`);
  }

  function jump(index: number) {
    const mark = latest.current[index];

    if (!mark) return;
    // First, so the scroll about to happen is not mistaken for the reader returning to the live edge.
    leaveLatest();

    // Not loaded yet: the conversation fetches back to it, and the effect below lands there.
    if (!turnNode(mark.id)) {
      onSeek(mark.id);

      return;
    }

    onSeek(undefined);
    land(mark.id);
  }

  function land(id: string) {
    const element = containerRef.current;

    if (!element) return;

    const settle = () => {
      const target = turnNode(id);

      if (!target) return true;

      const delta =
        target.getBoundingClientRect().top - element.getBoundingClientRect().top - TOP_GAP;

      if (Math.abs(delta) <= 2) return true;
      element.scrollTop += delta;

      return false;
    };

    let frames = 0;
    let settled = 0;

    const correct = () => {
      settled = settle() ? settled + 1 : 0;
      frames += 1;

      if (settled < 2 && frames < SETTLE_FRAMES) requestAnimationFrame(correct);
    };

    correct();
  }

  // After each page of earlier messages lands (and the conversation has kept the reader's place), check
  // whether the turn being reached for has arrived.
  useEffect(() => {
    if (seeking === undefined || !turnNode(seeking)) return;

    onSeek(undefined);
    leaveLatest();
    land(seeking);
  });

  function show(next: boolean, delay: number) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  }

  function onKeyDown(event: KeyboardEvent) {
    const step = (to: number) => {
      event.preventDefault();
      window.clearTimeout(timer.current);
      setOpen(true);
      setActive(Math.max(0, Math.min(count - 1, to)));
    };

    if (event.key === "ArrowDown" || event.key === "ArrowRight") step(active + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") step(active - 1);
    else if (event.key === "Home") step(0);
    else if (event.key === "End") step(count - 1);
    else if (event.key === "Escape") setOpen(false);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      jump(active);
    }
  }

  const visible = enabled && scrollable && height > 0;
  const shown = marks[Math.min(active, count - 1)];

  // Hang the card off the tick it describes, kept inside the conversation.
  useLayoutEffect(() => {
    const box = card.current;

    if (!box || !open) return;

    const centre = (height - boxH) / 2 + tickY(active);
    const highest = height - box.offsetHeight - CARD_EDGE;
    setCardTop(Math.max(CARD_EDGE, Math.min(centre - box.offsetHeight / 2, highest)));
  });

  if (!visible) return null;

  return (
    <>
      <button
        ref={rail}
        type="button"
        className="turn-rail"
        aria-label="Jump to a message"
        aria-busy={seeking !== undefined || undefined}
        style={{ left: RAIL_EDGE, width: RAIL_W, height: boxH }}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          // Name the tick in the same event that wakes the rail, so the ripple starts under the pointer.
          setActive(indexAt(event.clientY));
          setHovered(true);
          setEntering(true);
          show(true, OPEN_DELAY);
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "touch") setActive(indexAt(event.clientY));
        }}
        onPointerLeave={() => {
          setHovered(false);
          show(false, CLOSE_DELAY);
        }}
        onFocus={(event) => {
          // Only a keyboard arrival resets the target; a click has already named its tick.
          if (!event.currentTarget.matches(":focus-visible")) return;
          setActive(current);
          setKeyboard(true);
          setEntering(true);
        }}
        onBlur={() => {
          if (keyboard) setOpen(false);
          setKeyboard(false);
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          // Keyboard activation arrives as a click at 0,0, and Enter has already jumped.
          if (event.detail === 0) return;
          jump(indexAt(event.clientY));
        }}
      >
        {marks.map((mark, index) => {
          // Distance from the pointer decides a tick's size, with its resting size as the floor, so the
          // turn being read stays visible through the lens.
          const lift = hot ? (LENS[Math.abs(index - active)] ?? 0) : 0;
          const here = index === current;

          const width = Math.max(
            here ? TICK_CURRENT_W : TICK_REST_W,
            TICK_REST_W + (TICK_MAX_W - TICK_REST_W) * lift,
          );

          const tall = Math.max(
            here ? TICK_MAX_H : TICK_REST_H,
            TICK_REST_H + (TICK_MAX_H - TICK_REST_H) * lift,
          );

          return (
            <span
              key={mark.id}
              aria-hidden="true"
              className="turn-tick"
              data-current={here || undefined}
              data-seeking={mark.id === seeking || undefined}
              style={{
                top: tickY(index) - TICK_MAX_H / 2,
                width: TICK_MAX_W,
                height: TICK_MAX_H,
                transform: `scale(${width / TICK_MAX_W}, ${tall / TICK_MAX_H})`,
                // Where you are steps back while the lens is up: two peaks at full ink would read as two
                // targets, and only one is what a click takes.
                opacity: Math.max(
                  here ? (hot ? TICK_HERE_INK : 1) : TICK_REST_INK,
                  TICK_REST_INK + (1 - TICK_REST_INK) * lift,
                ),
                transitionDelay: entering
                  ? `${Math.min(Math.abs(index - active), STAGGER_MAX) * STAGGER_MS}ms`
                  : "0ms",
              }}
            />
          );
        })}
        {keyboard && shown && (
          <span aria-live="polite" className="sr-only">
            {`Message ${active + 1} of ${count}: ${shown.preview}`}
          </span>
        )}
      </button>
      {open && shown && (
        <div
          ref={card}
          className="turn-preview"
          style={{ top: cardTop, left: RAIL_EDGE + RAIL_W + 10 }}
          aria-hidden="true"
        >
          <p className="turn-preview-title">{shown.preview}</p>
          {shown.reply && <p className="turn-preview-reply">{shown.reply}</p>}
          <div className="turn-preview-meta">
            {shown.outcome && (
              <span className="turn-preview-outcome">
                <OutcomeIcon kind={shown.outcome.kind} />
                <span>{shown.outcome.label}</span>
              </span>
            )}
            {shown.at !== undefined && <time>You · {ago(shown.at, now)} ago</time>}
          </div>
        </div>
      )}
    </>
  );
}
