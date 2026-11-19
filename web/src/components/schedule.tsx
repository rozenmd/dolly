import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { XMarkIcon } from "@heroicons/react/16/solid";
import { ClockIcon } from "@heroicons/react/24/outline";
import {
  cancelScheduledPrompt,
  dateInput,
  quickPicks,
  schedulePrompt,
  scheduledPrompts,
  untilLabel,
  type ScheduledPrompt,
} from "../lib/scheduled";
import { Input, Modal } from "./ui";

/** How often the pending list refreshes on its own, besides after each change and new activity. */
const REFRESH_MS = 30_000;

/**
 * The composer's "send later": a clock beside the send button that schedules the current draft
 * for this session (Slack-style quick picks or a custom date and time), and lists what is already
 * scheduled here, the agent's check-backs included, each with a countdown and a cancel.
 * A badge counts the pending ones. Scheduled text arrives as if typed at that time.
 */
export function ScheduleButton({
  session,
  draft,
  disabled,
  activity,
  unavailable,
  onScheduled,
}: {
  session: string;
  /** The composer's draft: what a pick schedules. */
  draft: string;
  disabled?: boolean;
  /** Changes when the conversation moves, so a schedule the agent just made shows up. */
  activity: number;
  /** Why the draft can't be scheduled as it stands, such as attached screenshots. */
  unavailable?: string;
  /** Called once the draft is scheduled, so the composer can clear it. */
  onScheduled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState<{ date: string; time: string } | null>(null);
  const [pending, setPending] = useState<readonly ScheduledPrompt[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const root = useRef<HTMLDivElement>(null);
  const hasDraft = draft.trim().length > 0 && !unavailable;

  const load = useCallback(
    (signal?: AbortSignal) =>
      scheduledPrompts(session, signal)
        .then((items) => {
          setPending(items);
          setNow(Date.now());
        })
        .catch(() => {}),
    [session],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), REFRESH_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load, activity]);

  useEffect(() => {
    setOpen(false);
    setPending([]);
    setError("");
  }, [session]);

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function schedule(at: Date) {
    const content = draft.trim();

    if (!content || saving) return;
    setSaving(true);
    setError("");

    try {
      await schedulePrompt(session, { content, at, requestId: crypto.randomUUID() });
      setOpen(false);
      setCustom(null);
      onScheduled();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not schedule the message.");
    } finally {
      setSaving(false);
    }
  }

  async function cancel(id: string) {
    setError("");

    try {
      await cancelScheduledPrompt(session, id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not cancel the message.");
    }

    await load();
  }

  function openCustom() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setCustom({ date: dateInput(tomorrow), time: "09:00" });
    setError("");
    setOpen(false);
  }

  function submitCustom(event: FormEvent) {
    event.preventDefault();

    if (!custom) return;
    const at = new Date(`${custom.date}T${custom.time}`);

    if (Number.isNaN(at.getTime())) setError("Pick a valid date and time.");
    else if (at.getTime() <= Date.now() + 60_000) setError("Pick a time in the future.");
    else if (at.getTime() > Date.now() + 7 * 86_400_000)
      setError("Pick a time within the next 7 days.");
    else void schedule(at);
  }

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div ref={root} className="schedule">
      <button
        type="button"
        className="attach-button schedule-trigger"
        aria-label={pending.length ? `Send later (${pending.length} scheduled)` : "Send later"}
        title="Send later"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setNow(Date.now());
          setOpen(!open);
        }}
      >
        <ClockIcon aria-hidden="true" />
        {pending.length > 0 && (
          <span className="schedule-badge" aria-hidden="true">
            {pending.length}
          </span>
        )}
      </button>
      {open && (
        <div className="schedule-menu" role="menu" aria-label="Send later">
          {pending.length > 0 && (
            <ul className="schedule-pending" aria-label="Scheduled messages">
              {pending.map((item) => (
                <li key={item.id}>
                  <time
                    dateTime={item.at}
                    title={new Date(item.at).toLocaleString()}
                    className="schedule-when"
                  >
                    {untilLabel(Date.parse(item.at), now)}
                  </time>
                  <span className="schedule-text" title={item.prompt}>
                    {item.prompt}
                  </span>
                  {item.source === "agent" && <span className="schedule-source">agent</span>}
                  <button
                    type="button"
                    className="schedule-cancel"
                    aria-label="Cancel scheduled message"
                    title="Cancel scheduled message"
                    onClick={() => void cancel(item.id)}
                  >
                    <XMarkIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="schedule-heading">
            {unavailable ??
              (hasDraft ? "Send this message later" : "Type a message to send it later")}
          </p>
          {quickPicks(new Date(now)).map((pick) => (
            <button
              key={pick.at.getTime()}
              type="button"
              role="menuitem"
              className="picker-action"
              disabled={!hasDraft || saving}
              onClick={() => void schedule(pick.at)}
            >
              {pick.label}
            </button>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            className="picker-action"
            disabled={!hasDraft || saving}
            onClick={openCustom}
          >
            Custom time…
          </button>
          {error && !custom && (
            <p role="alert" className="error-text schedule-error">
              {error}
            </p>
          )}
        </div>
      )}
      {custom && (
        <Modal title="Send later" onClose={() => setCustom(null)} className="schedule-modal">
          <form onSubmit={submitCustom}>
            <p className="field-help">Time zone: {zone}</p>
            <div className="schedule-fields">
              <label className="sr-only" htmlFor="schedule-date">
                Date
              </label>
              <Input
                id="schedule-date"
                type="date"
                value={custom.date}
                min={dateInput(new Date())}
                onChange={(event) => setCustom({ ...custom, date: event.target.value })}
              />
              <label className="sr-only" htmlFor="schedule-time">
                Time
              </label>
              <Input
                id="schedule-time"
                type="time"
                value={custom.time}
                onChange={(event) => setCustom({ ...custom, time: event.target.value })}
              />
            </div>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setCustom(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={saving || !custom.date || !custom.time}
              >
                {saving ? "Scheduling…" : "Schedule message"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
