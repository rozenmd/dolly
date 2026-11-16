import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon } from "@heroicons/react/16/solid";
import {
  ArrowTopRightOnSquareIcon,
  CpuChipIcon,
  DocumentDuplicateIcon,
  DocumentIcon,
  HashtagIcon,
  ListBulletIcon,
} from "@heroicons/react/24/outline";
import type { SavedSession } from "../lib/api";
import type { SessionSummary as SummaryState } from "../lib/session-summary";
import {
  groupThreads,
  THREAD_STATE_LABEL,
  threadState,
  threadStatusLine,
} from "../lib/session-threads";
import { ago } from "../lib/time";
import { effortName, modelName } from "./model-select";
import { PullRequestIcon } from "./sidebar";
import { IconButton, RepoBadge } from "./ui";

export const sessionSummaryId = "session-summary";

const PULL_HEADLINES = {
  open: "Pull request open",
  draft: "Draft pull request",
  merged: "Merged",
  closed: "Closed",
} as const;

export type ThreadRow = {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  pullRequest?: SavedSession["pullRequest"];
};

/** The threads a session handed work to, grouped by where they stand (opensession's Threads panel). */
function ThreadsBand({
  threads,
  onOpen,
}: {
  threads: readonly ThreadRow[];
  onOpen: (id: string) => void;
}) {
  const now = Date.now();
  const shipped = threads.filter((thread) => threadState(thread) === "shipped").length;

  return (
    <section aria-label="Threads" className="summary-threads">
      <h2 className="summary-section">
        Threads <span className="thread-count">{threads.length}</span>
        <span className="thread-summary">
          {shipped} shipped · {threads.length - shipped} open
        </span>
      </h2>
      {groupThreads(threads).map((group) => (
        <section
          key={group.state}
          className="thread-group"
          aria-label={THREAD_STATE_LABEL[group.state]}
        >
          <h3>
            {THREAD_STATE_LABEL[group.state]} <span>{group.threads.length}</span>
          </h3>
          <ul className="thread-list">
            {group.threads.map((thread) => (
              <li key={thread.id}>
                <button type="button" className="thread-row" onClick={() => onOpen(thread.id)}>
                  <span className={`thread-dot ${group.state}`} aria-hidden="true" />
                  <span className="thread-text">
                    <span className="thread-title">{thread.title}</span>
                    <span className="thread-status">{threadStatusLine(thread)}</span>
                  </span>
                  <span className="thread-time">{ago(thread.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

/** The header button that shows and hides the summary card. */
export function SessionSummaryToggle({ summary }: { summary: SummaryState }) {
  return (
    <IconButton
      label="Session summary"
      data-summary-toggle=""
      aria-controls={summary.open ? sessionSummaryId : undefined}
      aria-expanded={summary.open}
      className={summary.open ? "pressed" : ""}
      onClick={() => summary.setOpen(!summary.open)}
    >
      <ListBulletIcon />
    </IconButton>
  );
}

/** One quiet row: a glyph in a shared rail, a label, and a value at the right edge. */
function Row({
  icon,
  label,
  value,
  href,
  title,
}: {
  icon: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  href?: string;
  title?: string;
}) {
  const body = (
    <>
      <span className="summary-rail" aria-hidden="true">
        {icon}
      </span>
      <span className="summary-label">{label}</span>
      {value !== undefined && <span className="summary-value">{value}</span>}
    </>
  );

  return href ? (
    <a className="summary-row link" href={href} target="_blank" rel="noreferrer" title={title}>
      {body}
    </a>
  ) : (
    <div className="summary-row" title={title}>
      {body}
    </div>
  );
}

/**
 * A floating card at the top right of the conversation pane that summarises
 * the session, modelled on Open Session's workspace summary: the pull request
 * and where it stands in a tinted band at the top, then quiet rows for the
 * agent's status and the diff size, the threads it spawned, then the
 * repository, the model and the session ID.
 *
 * On a pane with room it stands beside the transcript, which steps aside for
 * it. On a narrower pane it is an overlay that closes on Escape or the next
 * click outside it.
 */
export function SessionSummaryCard({
  summary,
  session,
  running,
  failure,
  threads,
  onOpenThread,
}: {
  summary: SummaryState;
  session: SavedSession;
  running: boolean;
  failure?: string;
  threads: readonly ThreadRow[];
  onOpenThread: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const { setOpen, standing } = summary;
  const pull = session.pullRequest;
  const state = pull?.state ?? "open";
  const github = /^[\w.-]+\/[\w.-]+$/.test(session.repository);

  const status = running
    ? "Working"
    : failure === "aborted"
      ? "Stopped"
      : failure
        ? "Failed"
        : "Idle";

  useEffect(() => setCopied(false), [session.id]);

  // An overlay leaves like any other popup; a standing card stays put.
  useEffect(() => {
    if (standing) return;

    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(`#${sessionSummaryId}, [data-summary-toggle]`)
      )
        return;
      setOpen(false);
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
  }, [standing, setOpen]);

  return (
    <aside
      id={sessionSummaryId}
      className={`session-summary ${standing ? "standing" : "overlay"}`}
      aria-label="Session summary"
    >
      {pull && (
        <div className={`summary-band pr-${state}`}>
          <div className="summary-band-text">
            <span className="summary-headline">{PULL_HEADLINES[state]}</span>
            <a
              className="summary-pull"
              href={pull.url}
              target="_blank"
              rel="noreferrer"
              title={pull.title ? `#${pull.number} ${pull.title}` : `#${pull.number}`}
            >
              <PullRequestIcon aria-hidden="true" />
              <span>
                #{pull.number}
                {pull.title ? ` ${pull.title}` : ""}
              </span>
            </a>
          </div>
          <a
            className="summary-action"
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open pull request #${pull.number} on GitHub`}
          >
            <ArrowTopRightOnSquareIcon aria-hidden="true" />
            View
          </a>
        </div>
      )}
      <Row
        icon={
          <span className={`status-dot ${running ? "working" : failure ? "failed" : "idle"}`} />
        }
        label={status}
      />
      {pull && (pull.additions !== undefined || pull.deletions !== undefined) && (
        <Row
          icon={<DocumentIcon />}
          label="Changes"
          href={`${pull.url}/files`}
          title={
            pull.changedFiles === undefined
              ? undefined
              : `${pull.changedFiles} file${pull.changedFiles === 1 ? "" : "s"} changed`
          }
          value={
            <>
              <span className="added">+{pull.additions ?? 0}</span>{" "}
              <span className="removed">−{pull.deletions ?? 0}</span>
            </>
          }
        />
      )}
      {threads.length > 0 && <ThreadsBand threads={threads} onOpen={onOpenThread} />}
      <h2 className="summary-section">Session</h2>
      {session.repository && (
        <Row
          icon={<RepoBadge repository={session.repository} />}
          label={session.repository}
          href={github ? `https://github.com/${session.repository}` : undefined}
        />
      )}
      <Row
        icon={<CpuChipIcon />}
        label={modelName(session.model)}
        title={session.model}
        value={session.thinkingLevel ? effortName(session.thinkingLevel) : undefined}
      />
      <div className="summary-row">
        <span className="summary-rail" aria-hidden="true">
          <HashtagIcon />
        </span>
        <code className="summary-label">{session.id}</code>
        <IconButton
          label={copied ? "Session ID copied" : "Copy session ID"}
          className="summary-copy"
          onClick={() =>
            void navigator.clipboard.writeText(session.id).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? <CheckIcon /> : <DocumentDuplicateIcon />}
        </IconButton>
      </div>
    </aside>
  );
}
