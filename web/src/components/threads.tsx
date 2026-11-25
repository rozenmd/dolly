import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRightIcon } from "@heroicons/react/16/solid";
import * as Schema from "effect/Schema";
import { request, Snapshot, turnsFromSnapshot, type SavedSession } from "../lib/api";
import {
  groupThreads,
  latestStep,
  replyGist,
  THREAD_STATE_LABEL,
  threadState,
  threadStatusLine,
  type ThreadState,
} from "../lib/session-threads";
import { ago } from "../lib/time";

/** What thread cards, rows and the thread view show about a spawned session, from the session list. */
export type ThreadSession = {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  pullRequest?: SavedSession["pullRequest"];
};

const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot));

async function readTurns(id: string) {
  return turnsFromSnapshot(decodeSnapshot(await request(`/sessions/${encodeURIComponent(id)}`)));
}

const phoneQuery = "(max-width: 760px)";

function subscribePhone(listener: () => void) {
  const query = window.matchMedia(phoneQuery);
  query.addEventListener("change", listener);

  return () => query.removeEventListener("change", listener);
}

/** A phone opens a thread as its own page; wider screens open it beside the conversation. */
export function usePhone() {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(phoneQuery).matches,
    () => false,
  );
}

/** How often a working thread's card re-reads its latest step. */
const ACTIVITY_POLL_MS = 5_000;

/**
 * What a working thread is doing right now, in one line ("Editing checkout.tsx"). Read from its
 * transcript only while it works and the page is visible; null otherwise and before the first read.
 */
export function useThreadActivity(id: string, working: boolean): string | null {
  const [activity, setActivity] = useState<{ id: string; text: string }>();

  useEffect(() => {
    if (!working) return;
    let live = true;

    const read = () => {
      if (document.visibilityState !== "visible") return;

      void readTurns(id)
        .then((turns) => {
          const text = latestStep(turns);

          if (live && text) setActivity({ id, text });
        })
        .catch(() => {});
    };

    read();
    const timer = window.setInterval(read, ACTIVITY_POLL_MS);

    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [id, working]);

  return working && activity?.id === id ? activity.text : null;
}

/** Gists by `id:updatedAt`, so a thread is read again only after it moved. Shared by every row. */
const gists = new Map<string, Promise<string | null>>();

/**
 * The gist of what a thread last said, for threads that have stopped moving. A working one says
 * "Working" until it settles; reading it on every change would cost a transcript read each time.
 */
export function useThreadGist(thread: ThreadSession, state: ThreadState): string | null {
  // A running thread is still writing its reply even when its state says otherwise (a merged PR
  // is "shipped" while a follow-up runs), so nothing is cached until it stops.
  const key = state === "working" || thread.running ? null : `${thread.id}:${thread.updatedAt}`;
  const [gist, setGist] = useState<{ key: string; text: string | null }>();

  useEffect(() => {
    if (!key) return;
    let pending = gists.get(key);

    if (!pending) {
      pending = readTurns(thread.id)
        .then((turns) => {
          const answer = turns.findLast((turn) => turn.answer)?.answer?.text;

          return answer ? replyGist(answer) : null;
        })
        .catch(() => null);
      gists.set(key, pending);
    }

    let live = true;

    void pending.then((text) => {
      if (live) setGist({ key, text });
    });

    return () => {
      live = false;
    };
  }, [key, thread.id]);

  return key && gist?.key === key ? gist.text : null;
}

/** A robot, after the heroicons outline set. */
function RobotIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3.75v2.5M7.5 6.25h9a2.25 2.25 0 0 1 2.25 2.25v7.25a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25V8.5A2.25 2.25 0 0 1 7.5 6.25ZM9.75 14.5h4.5M3 11v3m18-3v3"
      />
      <circle cx="9.5" cy="10.75" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="10.75" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The state dot every thread row, card and view leads with. */
export function ThreadDot({ state }: { state?: ThreadState }) {
  return <span className={`thread-dot ${state ?? "pending"}`} aria-hidden="true" />;
}

/** A robot on a round tile, with the thread's state dot on its corner. */
function AgentMark({ state }: { state?: ThreadState }) {
  return (
    <span className="agent-mark" aria-hidden="true">
      <RobotIcon />
      <ThreadDot state={state} />
    </span>
  );
}

/**
 * The threads a turn started, as one card under the turn: an agent mark, what it was asked to do
 * and one line on where it stands, with its current step while it works. Not a second copy of its
 * report: the turn's reply and the report card say what it found.
 */
export function ThreadCards({
  ids,
  lookup,
  onOpen,
}: {
  ids: readonly string[];
  lookup?: (id: string) => ThreadSession | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="thread-cards" aria-label="Threads started here">
      {ids.map((id) => (
        <li key={id}>
          <ThreadCard id={id} session={lookup?.(id)} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function ThreadCard({
  id,
  session,
  onOpen,
}: {
  id: string;
  session?: ThreadSession;
  onOpen: (id: string) => void;
}) {
  const state = session ? threadState(session) : undefined;
  const activity = useThreadActivity(id, state === "working");
  const title = session?.title || "Thread";
  const status = session ? threadStatusLine(session) : "Starting";

  return (
    <button
      type="button"
      className="thread-card"
      aria-label={`Open thread: ${title}, ${status}`}
      onClick={() => onOpen(id)}
    >
      <AgentMark state={state} />
      <span className="thread-text">
        <span className="thread-title">{title}</span>
        <span className="thread-status">
          {status}
          {activity && (
            <span className="thread-activity" title={activity}>
              {" "}
              · {activity}
            </span>
          )}
        </span>
      </span>
      <ChevronRightIcon className="thread-card-chevron" aria-hidden="true" />
    </button>
  );
}

/** Groups that start folded: work that needs nothing more from anyone. */
const FOLDED_AT_FIRST: ReadonlySet<ThreadState> = new Set(["shipped"]);

/** A session's threads by where they stand; each caption folds its group. */
export function ThreadGroups({
  threads,
  onOpen,
}: {
  threads: readonly ThreadSession[];
  onOpen: (id: string) => void;
}) {
  const [folded, setFolded] = useState(FOLDED_AT_FIRST);
  const now = Date.now();

  return (
    <div className="thread-groups">
      {groupThreads(threads).map((group) => {
        const open = !folded.has(group.state);

        return (
          <section
            key={group.state}
            className="thread-group"
            aria-label={THREAD_STATE_LABEL[group.state]}
          >
            <button
              type="button"
              className="thread-caption"
              aria-expanded={open}
              onClick={() =>
                setFolded((previous) => {
                  const next = new Set(previous);

                  if (!next.delete(group.state)) next.add(group.state);

                  return next;
                })
              }
            >
              {THREAD_STATE_LABEL[group.state]}
              <span className="thread-count">{group.threads.length}</span>
              <ChevronRightIcon
                className={`thread-fold ${open ? "open" : ""}`}
                aria-hidden="true"
              />
            </button>
            {open && (
              <ul className="thread-list">
                {group.threads.map((thread) => (
                  <li key={thread.id}>
                    <ThreadRow thread={thread} now={now} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** One thread: state dot, title, where it stands with its diff and last word, and when. */
function ThreadRow({
  thread,
  now,
  onOpen,
}: {
  thread: ThreadSession;
  now: number;
  onOpen: (id: string) => void;
}) {
  const state = threadState(thread);
  const gist = useThreadGist(thread, state);
  const pull = thread.pullRequest;

  const diff =
    pull && pull.state !== "merged" && (pull.additions || pull.deletions)
      ? { added: pull.additions ?? 0, removed: pull.deletions ?? 0 }
      : undefined;

  return (
    <button
      type="button"
      className="thread-row"
      title={gist ? `${thread.title}\n${gist}` : thread.title}
      onClick={() => onOpen(thread.id)}
    >
      <ThreadDot state={state} />
      <span className="thread-text">
        <span className="thread-title">{thread.title}</span>
        <span className="thread-status">
          {threadStatusLine(thread)}
          {diff && (
            <span className="thread-diff">
              {" · "}
              <span className="added">+{diff.added}</span>{" "}
              <span className="removed">−{diff.removed}</span>
            </span>
          )}
          {gist && <span className="thread-gist"> · {gist}</span>}
        </span>
      </span>
      <span className="thread-time">{ago(thread.updatedAt, now)}</span>
    </button>
  );
}
