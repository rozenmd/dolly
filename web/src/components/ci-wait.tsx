import { XMarkIcon } from "@heroicons/react/16/solid";
import { CheckBadgeIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { cancelCiWait, ciWait, type CiWait } from "../lib/ci-wait";

const REFRESH_MS = 15_000;

function timeout(at: number, now: number) {
  const minutes = Math.round((at - now) / 60_000);

  return minutes < 1 ? "times out now" : `times out in ${minutes}m`;
}

function countdown(at: number, now: number) {
  const seconds = Math.round((at - now) / 1000);

  if (seconds <= 0) return "checking now";

  return seconds < 90 ? `next check in ${seconds}s` : `next check in ${Math.round(seconds / 60)}m`;
}

/**
 * Above the composer while the agent waits with wait_for, on CI or on another session's turn: what
 * it's watching, what the last check saw, and a way to stop waiting. The wait itself runs in the
 * Worker; nothing here polls GitHub.
 */
export function CiWaitStrip({ session, activity }: { session: string; activity: number }) {
  const [wait, setWait] = useState<CiWait | null>(null);
  const [now, setNow] = useState(Date.now);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) =>
      ciWait(session, signal)
        .then(setWait)
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
    const timer = setInterval(() => setNow(Date.now()), 5_000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => setWait(null), [session]);

  if (!wait) return null;
  const sessionTurn = wait.kind === "session_turn";

  async function cancel() {
    setCancelling(true);

    try {
      await cancelCiWait(session);
      setWait(null);
    } catch {
      await load();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section
      className="ci-wait-strip"
      aria-label={sessionTurn ? "Waiting on a session" : "Waiting on CI"}
    >
      <CheckBadgeIcon className="ci-wait-strip-icon" aria-hidden="true" />
      <div className="ci-wait-strip-text">
        <p>
          Waiting on <strong>{wait.waiting_on}</strong>
        </p>
        <p className="ci-wait-strip-seen">
          {sessionTurn
            ? `wakes when its turn ends · ${timeout(Date.parse(wait.timeout), now)}`
            : countdown(Date.parse(wait.next_poll), now)}
          {wait.last_seen && ` · last seen ${wait.last_seen}`}
        </p>
      </div>
      <button
        type="button"
        className="queue-steer ci-wait-cancel"
        disabled={cancelling}
        aria-label={sessionTurn ? "Stop waiting on the session" : "Stop waiting on CI"}
        title="Stop waiting: the agent won't be woken by this wait"
        onClick={() => void cancel()}
      >
        <XMarkIcon />
      </button>
    </section>
  );
}
