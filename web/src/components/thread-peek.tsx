import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpIcon, ChevronLeftIcon } from "@heroicons/react/16/solid";
import { ArrowsPointingOutIcon } from "@heroicons/react/24/outline";
import { liveFromSnapshot, request, Snapshot, turnsFromSnapshot } from "../lib/api";
import { THREAD_STATE_LABEL, threadState, threadStatusLine } from "../lib/session-threads";
import { watchSession } from "../lib/session-stream";
import { extendTranscript } from "../lib/transcript-history";
import { TurnList } from "./conversation";
import { PullRequestIcon } from "./sidebar";
import { ThreadDot, type ThreadSession } from "./threads";
import { IconButton } from "./ui";

/**
 * A thread opened inside the session summary: where it stands first (its state, its pull request
 * and diff), then its conversation, live, and a box to keep talking to it. Back returns to the
 * thread list; the expand button opens the thread as its own page when it needs the room.
 */
export function ThreadPeek({
  id,
  session,
  lookup,
  onBack,
  onOpenFull,
  onOpenThread,
}: {
  id: string;
  session?: ThreadSession;
  lookup: (id: string) => ThreadSession | undefined;
  onBack: () => void;
  onOpenFull: (id: string) => void;
  /** Open another thread here: one this thread started. */
  onOpenThread: (id: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<{ id: string; value: typeof Snapshot.Type }>();
  const [error, setError] = useState("");
  const [choices] = useState(() => new Map<string, Map<string, boolean>>());
  const scroll = useRef<HTMLDivElement>(null);
  // Opens on where the thread stands; once the reader scrolls to the end, new messages keep them there.
  const follow = useRef(false);
  const view = snapshot?.id === id ? snapshot.value : undefined;
  const turns = view ? turnsFromSnapshot(view) : [];
  const running = Boolean(view && liveFromSnapshot(view)?.run);
  const [now, setNow] = useState(Date.now);
  const state = session ? threadState(session) : undefined;
  const pull = session?.pullRequest;
  const threadChoices = choices.get(id) ?? new Map<string, boolean>();

  choices.set(id, threadChoices);

  useEffect(() => {
    setError("");
    follow.current = false;

    return watchSession(
      id,
      (value) => {
        setSnapshot((held) => ({
          id,
          value: extendTranscript(held?.id === id ? held.value : null, value),
        }));
        setError("");
      },
      setError,
    );
  }, [id]);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [running]);

  useLayoutEffect(() => {
    const element = scroll.current;

    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [view]);

  return (
    <div className="thread-peek" aria-label={`Thread: ${session?.title || "Thread"}`} role="region">
      <header className="thread-peek-header">
        <button type="button" className="thread-peek-back" onClick={onBack}>
          <ChevronLeftIcon aria-hidden="true" />
          Threads
        </button>
        <span className="thread-peek-title" title={session?.title}>
          <ThreadDot state={state} />
          <span>{session?.title || "Thread"}</span>
        </span>
        <IconButton label="Open as its own page" onClick={() => onOpenFull(id)}>
          <ArrowsPointingOutIcon />
        </IconButton>
      </header>
      <div
        className="thread-peek-scroll"
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
        }}
      >
        {session && state && (
          <section className="thread-peek-summary" aria-label="Where the thread stands">
            <span className="thread-peek-state">
              <strong>{THREAD_STATE_LABEL[state]}</strong>
              {threadStatusLine(session) !== THREAD_STATE_LABEL[state] &&
                ` · ${threadStatusLine(session)}`}
            </span>
            {pull && (
              <a
                className="thread-peek-pull"
                href={pull.url}
                target="_blank"
                rel="noreferrer"
                title={pull.title ? `#${pull.number} ${pull.title}` : `#${pull.number}`}
              >
                <PullRequestIcon aria-hidden="true" />
                <span className="thread-peek-pull-title">
                  #{pull.number}
                  {pull.title ? ` ${pull.title}` : ""}
                </span>
                {pull.state !== "merged" &&
                  (pull.additions !== undefined || pull.deletions !== undefined) && (
                    <span className="thread-diff">
                      <span className="added">+{pull.additions ?? 0}</span>{" "}
                      <span className="removed">−{pull.deletions ?? 0}</span>
                    </span>
                  )}
              </a>
            )}
          </section>
        )}
        <div className="thread-peek-transcript">
          {error && !view ? (
            <p className="conversation-status" role="alert">
              {error}
            </p>
          ) : !view ? (
            <p className="conversation-status" role="status">
              Loading thread…
            </p>
          ) : turns.length === 0 ? (
            <p className="conversation-status">Nothing in this thread yet.</p>
          ) : (
            <TurnList
              turns={turns}
              choices={threadChoices}
              now={now}
              thread={lookup}
              onOpenThread={onOpenThread}
            />
          )}
        </div>
      </div>
      <ThreadReply id={id} />
    </div>
  );
}

/** The box under a thread: a message goes straight to the thread's agent, as if typed in it. */
function ThreadReply({ id }: { id: string }) {
  const [drafts] = useState(() => new Map<string, string>());
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setText(drafts.get(id) ?? "");
    setError("");
  }, [id, drafts]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const content = text.trim();

    if (!content || pending) return;
    setPending(true);
    setError("");

    try {
      await request(`/sessions/${encodeURIComponent(id)}/messages`, {
        content,
        requestId: crypto.randomUUID(),
      });
      drafts.delete(id);
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the message.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="thread-peek-reply" onSubmit={(event) => void submit(event)}>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="thread-peek-box">
        <textarea
          aria-label="Message this thread"
          placeholder="Message this thread"
          rows={1}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            drafts.set(id, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <IconButton
          label="Send to thread"
          type="submit"
          className="thread-peek-send"
          disabled={pending || !text.trim()}
        >
          <ArrowUpIcon />
        </IconButton>
      </div>
    </form>
  );
}
