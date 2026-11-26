import { modelName } from "./model-select";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  ArrowTurnDownLeftIcon,
  ArrowUpIcon,
  ArrowsRightLeftIcon,
  BoltIcon,
  CheckIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
  StopIcon,
} from "@heroicons/react/16/solid";
import {
  CheckBadgeIcon,
  CheckCircleIcon,
  ClockIcon,
  CodeBracketIcon,
  CommandLineIcon,
  DocumentDuplicateIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  FolderIcon,
  PencilIcon,
  UsersIcon,
  WrenchIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffTotal, type DiffStats, type QueuedMessage, type Step, type Turn } from "../lib/api";
import { ago, duration } from "../lib/time";
import { formatToolOutput, oneLine } from "../lib/tool-output";
import { IconButton, Textarea } from "./ui";
import { TurnRail } from "./turn-rail";
import { markEntry, railMarks, wholeRail, type RailMark } from "../lib/turn-rail";
import { AttachButton, AttachmentTray, useAttachmentInput } from "./attachments";
import { ScheduleButton } from "./schedule";
import { CiWaitStrip } from "./ci-wait";
import { MessageQueue } from "./queue";
import {
  modEnterGlyph,
  onBusySendChanged,
  otherBusySend,
  readBusySend,
  saveBusySend,
  type BusySend,
} from "../lib/busy-send";

import type { Attachment } from "../lib/images";
import { spawnedThreadId } from "../lib/session-threads";
import { ThreadCards, type ThreadSession } from "./threads";

/** How long the first Escape of a run stays armed waiting for the second. */
const ESC_STOP_WINDOW_MS = 1500;

/** How long a touch holds the send button to open its options. */
const LONG_PRESS_MS = 800;

type ThreadLookup = {
  thread?: (id: string) => ThreadSession | undefined;
  onOpenThread?: (id: string) => void;
};

function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

/** Transcript entries older than those shown, loaded as the reader scrolls back. */
export type OlderHistory = {
  /** The entry just before the oldest one shown; absent once the conversation's start is shown. */
  before?: number;
  loading: boolean;
  error: string;
  /** Loads the next page back, or every page back to `until` (an entry ID) when given. */
  load: (until?: number) => void;
  /** Rail marks for the prompts not loaded yet, oldest first, when the server has indexed them. */
  index?: readonly RailMark[];
};

/** How close to the top, in pixels, scrolling back starts loading earlier messages. */
const OLDER_MARGIN = 600;

export function Conversation({
  turns,
  sessionId,
  loading,
  older,
  steering = [],
  onInterrupt,
  interrupting = false,
  thread,
  onOpenThread,
}: {
  turns: readonly Turn[];
  sessionId: string;
  loading: boolean;
  older?: OlderHistory;
  /** Messages sent into the running turn that its next step boundary hasn't delivered yet. */
  steering?: readonly QueuedMessage[];
  /** Stop the running turn and send this steer now, rather than after the current step. */
  onInterrupt?: (id: number) => void;
  /** An interrupt or another queue change is in flight. */
  interrupting?: boolean;
} & ThreadLookup) {
  const scroll = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Scroll height before earlier messages are prepended, to keep the reader's place once they arrive.
  const anchor = useRef<{ before: number; height: number }>(undefined);
  const load = useRef(older?.load);
  const before = older?.before;
  const olderLoading = older?.loading ?? false;
  const olderError = Boolean(older?.error);

  function loadOlder(until?: number) {
    if (scroll.current && before !== undefined)
      anchor.current = { before, height: scroll.current.scrollHeight };
    load.current?.(until);
  }

  const [now, setNow] = useState(Date.now);
  const index = older?.index;

  const marks = useMemo(
    () => wholeRail(index ?? [], railMarks(turns), before),
    [index, turns, before],
  );

  /** A rail mark whose turn isn't loaded yet: earlier messages load until it is, then the rail jumps there. */
  const [seeking, setSeeking] = useState<string>();

  const running = turns.some((turn) => turn.running);
  const [sessions] = useState(() => new Map<string, Map<string, boolean>>());
  const choices = sessions.get(sessionId) ?? new Map<string, boolean>();

  sessions.set(sessionId, choices);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [running, sessionId]);

  useLayoutEffect(() => {
    pinned.current = true;
    setSeeking(undefined);
  }, [sessionId]);

  // Fetch back to the turn the rail is reaching for, one request at a time; a failure waits for Retry.
  useEffect(() => {
    if (seeking === undefined) return;

    const entry = markEntry(seeking);

    if (entry === undefined || before === undefined || entry > before) {
      // Loaded (the rail has jumped), or nothing more to load.
      setSeeking(undefined);

      return;
    }

    if (!olderLoading && !olderError) loadOlder(entry);
  }, [seeking, before, olderLoading, olderError]);
  useLayoutEffect(() => {
    load.current = older?.load;
  });
  useLayoutEffect(() => {
    const element = scroll.current;

    if (!element) return;

    if (pinned.current) element.scrollTop = element.scrollHeight;
    else if (anchor.current && anchor.current.before !== before) {
      // Earlier messages went in above the reader: move down by what they added.
      element.scrollTop += element.scrollHeight - anchor.current.height;
      anchor.current = undefined;
    } else if (anchor.current) {
      // Live updates append below the reader without moving them; measure from here.
      anchor.current.height = element.scrollHeight;
    }
  }, [turns, before, steering.length]);

  // Load earlier messages once the top of the conversation comes near, and again after each page while it
  // stays near (a short page, or a tall window).
  useEffect(() => {
    const root = scroll.current;
    const target = top.current;

    // After a failure, only the Retry button asks again.
    if (before === undefined || olderLoading || olderError || !root || !target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) loadOlder();
      },
      { root, rootMargin: `${OLDER_MARGIN}px 0px 0px 0px` },
    );

    observer.observe(target);

    return () => observer.disconnect();
  }, [before, olderLoading, olderError, sessionId]);

  return (
    <div className="conversation-frame">
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
        }}
      >
        <div className="conversation-content">
          <div ref={top} aria-hidden="true" />
          {before !== undefined && turns.length > 0 && older && (
            <div className="history-loader">
              {older.error ? (
                <p role="alert">
                  {older.error}{" "}
                  <button type="button" onClick={() => loadOlder(seekingEntry(seeking))}>
                    Retry
                  </button>
                </p>
              ) : olderLoading ? (
                <p role="status">Loading earlier messages…</p>
              ) : (
                <button type="button" onClick={() => loadOlder()}>
                  Show earlier messages
                </button>
              )}
            </div>
          )}
          {loading && turns.length === 0 && (
            <p className="conversation-status" role="status">
              Loading conversation…
            </p>
          )}
          {!loading && turns.length === 0 && (
            <p className="conversation-status">Send a message to start.</p>
          )}
          <TurnList
            turns={turns}
            choices={choices}
            now={now}
            thread={thread}
            onOpenThread={onOpenThread}
          />
          {steering.map((item) => (
            <section key={`steer-${item.id}`} className="turn">
              <article className="prompt pending" aria-label="steering message">
                <div className="prompt-meta">
                  <span role="status">Sending after the current step…</span>
                  <span>You</span>
                </div>
                <div className="prompt-bubble">
                  <Prose text={item.text} />
                </div>
                {onInterrupt && (
                  <button
                    type="button"
                    className="steer-interrupt"
                    disabled={interrupting}
                    title="Stop what the agent is doing, including a running command, and send this now"
                    onClick={() => onInterrupt(item.id)}
                  >
                    <BoltIcon aria-hidden="true" />
                    Interrupt and send now
                  </button>
                )}
              </article>
            </section>
          ))}
        </div>
      </div>
      <TurnRail
        marks={marks}
        containerRef={scroll}
        leaveLatest={() => {
          pinned.current = false;
        }}
        seeking={seeking}
        onSeek={setSeeking}
        now={now}
      />
    </div>
  );
}

function seekingEntry(seeking: string | undefined) {
  return seeking === undefined ? undefined : markEntry(seeking);
}

function TurnView({ turn, now, thread, onOpenThread }: { turn: Turn; now: number } & ThreadLookup) {
  const started = turn.prompt?.at ?? turn.startedAt;

  const silent =
    !turn.running && !turn.answer && !turn.failure && !turn.interrupted && turn.items.length > 0;

  // Threads this turn started stay visible as cards even when the work log is folded.
  const spawned = turn.items.flatMap((item) =>
    item.kind === "steps"
      ? item.steps.flatMap((step) => {
          const id = spawnedThreadId(step.name, step.status, step.output);

          return id ? [id] : [];
        })
      : [],
  );

  return (
    <section className="turn" data-turn={turn.prompt ? turn.id : undefined}>
      {turn.prompt?.scheduled && (
        <ScheduledNotice
          id={turn.id}
          text={turn.prompt.text}
          deliveredAt={turn.prompt.at}
          now={now}
        />
      )}
      {turn.prompt?.ciWait && (
        <CiWaitNotice
          id={turn.id}
          wake={turn.prompt.ciWait}
          prompt={turn.prompt.text}
          deliveredAt={turn.prompt.at}
          now={now}
        />
      )}
      {turn.prompt?.sessionMessage && (
        <SessionMessageNotice
          id={turn.id}
          message={turn.prompt.sessionMessage}
          session={thread?.(turn.prompt.sessionMessage.session)}
          deliveredAt={turn.prompt.at}
          now={now}
          onOpen={onOpenThread}
        />
      )}
      {turn.prompt &&
        !turn.prompt.scheduled &&
        !turn.prompt.ciWait &&
        !turn.prompt.sessionMessage && (
          <article className="prompt" aria-label="user message">
            {turn.prompt.at !== undefined && (
              <div className="prompt-meta">
                <time dateTime={new Date(turn.prompt.at).toISOString()}>
                  {ago(turn.prompt.at, now)}
                </time>
                <span>You</span>
              </div>
            )}
            <div className="prompt-bubble">
              <Prose text={turn.prompt.text} />
              {Boolean(turn.prompt.images) && (
                <p className="prompt-images">
                  📎 {turn.prompt.images} screenshot{turn.prompt.images === 1 ? "" : "s"} attached
                </p>
              )}
            </div>
          </article>
        )}
      {turn.items.length > 0 && <WorkLog turn={turn} now={now} />}
      {spawned.length > 0 && onOpenThread && (
        <ThreadCards ids={[...new Set(spawned)]} lookup={thread} onOpen={onOpenThread} />
      )}
      {turn.answer && (
        <Answer id={turn.answer.id} text={turn.answer.text} at={turn.endedAt} now={now} />
      )}
      {turn.interrupted && (
        <p className="run-notice interrupted" role="status">
          Interrupted to send your next message.
        </p>
      )}
      {silent && (
        <p className="run-notice" role="status">
          The agent finished without a final reply. Its last messages are in the work log above.
        </p>
      )}
      {turn.failure && (
        <div className="run-failure" role={turn.failure.reason === "aborted" ? "status" : "alert"}>
          <strong>
            {turn.failure.reason === "aborted" ? "Agent stopped" : "Task ended without an answer"}
          </strong>
          <p>{turn.failure.detail || failureReason(turn.failure.reason)}</p>
        </div>
      )}
      {turn.running && turn.retry && (
        <p className="retry-status" role="status">
          Retrying {turn.retry.at > now ? `in ${duration(turn.retry.at - now)}` : "now"}…{" "}
          {turn.retry.error}
        </p>
      )}
      {turn.running && (
        <p className="running-footer" role="status">
          <span className="status-dot working" />
          {turn.activity ?? "Working"}
          {started !== undefined && (
            <span aria-live="off"> · {duration(Math.max(0, now - started))}</span>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * A prompt a schedule delivered, the agent's own check-back or the owner's "send later": a
 * notice rather than a bubble, since nobody typed it at this moment. Its text stays one click away.
 */
function ScheduledNotice({
  id,
  text,
  deliveredAt,
  now,
}: {
  id: string;
  text: string;
  deliveredAt?: number;
  now: number;
}) {
  const disclosure = useDisclosure(`scheduled-${id}`, false);

  return (
    <details className="scheduled-notice" aria-label="scheduled message" {...disclosure}>
      <summary>
        <ClockIcon aria-hidden="true" />
        <span className="scheduled-title">Scheduled message</span>
        {deliveredAt !== undefined && (
          <time dateTime={new Date(deliveredAt).toISOString()}>{ago(deliveredAt, now)}</time>
        )}
        <ChevronRightIcon className="disclosure" />
      </summary>
      <div className="scheduled-body">
        <Prose text={text} />
      </div>
    </details>
  );
}

const CI_WAIT_ICONS = {
  passed: CheckCircleIcon,
  failed: XCircleIcon,
  closed: CheckBadgeIcon,
  timed_out: ClockIcon,
  finished: CheckBadgeIcon,
};

/**
 * A CI wait woke the agent: what happened to the checks, as a notice rather than a bubble, since
 * the owner didn't type it. What GitHub reported and the agent's own follow-up are one click away.
 */
function CiWaitNotice({
  id,
  wake,
  prompt,
  deliveredAt,
  now,
}: {
  id: string;
  wake: NonNullable<NonNullable<Turn["prompt"]>["ciWait"]>;
  prompt: string;
  deliveredAt?: number;
  now: number;
}) {
  const disclosure = useDisclosure(`ci-wait-${id}`, false);
  const Icon = CI_WAIT_ICONS[wake.outcome];

  return (
    <details
      className="scheduled-notice ci-wait-notice"
      data-outcome={wake.outcome}
      aria-label={wake.kind === "session_turn" ? "Session wait result" : "CI wait result"}
      {...disclosure}
    >
      <summary>
        <Icon aria-hidden="true" />
        <span className="scheduled-title">{wake.headline}</span>
        {deliveredAt !== undefined && (
          <time dateTime={new Date(deliveredAt).toISOString()}>{ago(deliveredAt, now)}</time>
        )}
        <ChevronRightIcon className="disclosure" />
      </summary>
      <div className="scheduled-body">
        <Prose text={wake.trigger} />
        {prompt && <p className="ci-wait-next">Then: {prompt}</p>}
      </div>
    </details>
  );
}

/**
 * Another session's send_to_session: a worker reporting back, the server's notice that a worker's
 * run died, or a session's message. A notice rather than a bubble, since the owner didn't type it;
 * its words and the facts the server computed from the worker's transcript are one click away.
 */
function SessionMessageNotice({
  id,
  message,
  session,
  deliveredAt,
  now,
  onOpen,
}: {
  id: string;
  message: NonNullable<NonNullable<Turn["prompt"]>["sessionMessage"]>;
  session?: ThreadSession;
  deliveredAt?: number;
  now: number;
  onOpen?: (id: string) => void;
}) {
  const disclosure = useDisclosure(`child-report-${id}`, false);
  const failed = message.kind === "report" && message.failed;
  const outcome = message.kind === "message" ? "message" : failed ? "failed" : "answered";
  const Icon = failed ? ExclamationTriangleIcon : UsersIcon;
  const name = session?.title ?? message.session;
  const label = message.kind === "message" ? "Message from" : failed ? "Failed" : "Report";

  return (
    <details
      className="scheduled-notice child-report-notice"
      data-outcome={outcome}
      aria-label={message.kind === "message" ? "session message" : "child session report"}
      {...disclosure}
    >
      <summary>
        <Icon aria-hidden="true" />
        <span className="scheduled-title">
          {label}
          {message.kind === "message" ? " " : ": "}
          {name}
        </span>
        {deliveredAt !== undefined && (
          <time dateTime={new Date(deliveredAt).toISOString()}>{ago(deliveredAt, now)}</time>
        )}
        <ChevronRightIcon className="disclosure" />
      </summary>
      <div className="scheduled-body">
        <Prose text={message.text} />
        {message.kind === "report" && message.evidence && (
          <div className="child-report-facts">
            <p className="child-report-label">Computed by the server from its transcript</p>
            <pre className="child-report-evidence">{evidenceBody(message.evidence)}</pre>
          </div>
        )}
        {onOpen && (
          <button
            type="button"
            className="child-report-open"
            onClick={() => onOpen(message.session)}
          >
            Open {name}
          </button>
        )}
      </div>
    </details>
  );
}

/** The evidence block without its header line, which the label above already says. */
const evidenceBody = (evidence: string) => evidence.split("\n").slice(1).join("\n");

function failureReason(reason: string) {
  switch (reason) {
    case "model_error":
      return "The model request failed. Send another message to try again.";
    case "no_model":
      return "The selected model is unavailable.";
    case "aborted":
      return "This task was stopped before the agent answered.";
    case "turn_limit":
      return "The agent reached its tool-round limit. Send another message to continue.";
    case "nothing_to_answer":
      return "The run ended with no message to answer.";
    default:
      return `The agent could not complete this task (${reason}). Send another message to try again.`;
  }
}

/**
 * Open/closed choices the user made in this conversation, keyed by disclosure
 * id. Kept above the turn tree so a choice survives a remount (for example
 * when a live message is saved and its turn is rebuilt).
 */
const DisclosureChoices = createContext<Map<string, boolean>>(new Map());

/** Each turn of a transcript, without the scroller, rail or history loading around it. */
export function TurnList({
  turns,
  choices,
  now,
  thread,
  onOpenThread,
}: {
  turns: readonly Turn[];
  /** Open/closed choices made in this conversation, kept by the caller across remounts. */
  choices: Map<string, boolean>;
  now: number;
} & ThreadLookup) {
  return (
    <DisclosureChoices.Provider value={choices}>
      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} now={now} thread={thread} onOpenThread={onOpenThread} />
      ))}
    </DisclosureChoices.Provider>
  );
}

/**
 * Disclosure state for a step <details>. It starts in its default state and
 * only the user opens or closes it afterwards: run status never toggles it, so
 * it can't flash while the agent works.
 */
function useDisclosure(id: string, initial: boolean) {
  const choices = useContext(DisclosureChoices);
  const [open, setOpen] = useState(() => choices.get(id) ?? initial);

  return {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      const next = event.currentTarget.open;

      if (next === open) return;
      choices.set(id, next);
      setOpen(next);
    },
  };
}

function WorkLog({ turn, now }: { turn: Turn; now: number }) {
  // The work log is opened once when it appears (if running, failed, or
  // finished without a final reply, so nothing the agent wrote is hidden) and
  // is otherwise left entirely to the user.
  const [open, setOpen] = useState(() => turn.running || Boolean(turn.failure) || !turn.answer);

  const disclosure = {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open),
  };

  const started = turn.prompt?.at ?? turn.startedAt;

  const elapsed =
    started !== undefined && turn.endedAt !== undefined ? duration(turn.endedAt - started) : "";

  const changed = useMemo(
    () => diffTotal(turn.items.flatMap((item) => (item.kind === "steps" ? item.steps : []))),
    [turn.items],
  );

  return (
    <details className="work-log" {...disclosure}>
      <summary>
        <ChevronRightIcon className="disclosure" />
        <span className="work-label">{turn.running ? "Working" : "Worked"}</span>
        <span className="work-meta">
          {[!turn.running && elapsed, stepCount(turn.steps)].filter(Boolean).join(" · ")}
        </span>
        {changed && <DiffStat diff={changed} />}
      </summary>
      <div className="work-timeline">
        {turn.items.map((item) => (
          <Fragment key={item.id}>
            {item.kind === "text" && <Prose text={item.text} />}
            {item.kind === "fallback" && (
              <p className="fallback-note" role="note">
                <ArrowsRightLeftIcon aria-hidden="true" />
                <span>
                  Switched to <strong>{modelName(item.to)}</strong>: {modelName(item.from)} ran out
                  of usage
                </span>
              </p>
            )}
            {item.kind === "steps" && <StepGroup id={item.id} steps={item.steps} now={now} />}
          </Fragment>
        ))}
      </div>
    </details>
  );
}

function stepCount(count: number) {
  return count === 0 ? "" : `${count} ${count === 1 ? "step" : "steps"}`;
}

function StepGroup({ id, steps, now }: { id: string; steps: readonly Step[]; now: number }) {
  const running = steps.some((step) => step.status === "running");
  const failed = steps.some((step) => step.status === "error");
  const disclosure = useDisclosure(id, false);
  const changed = useMemo(() => diffTotal(steps), [steps]);

  return (
    <details className="step-group" {...disclosure}>
      <summary>
        <ChevronRightIcon className="disclosure" />
        <span>{stepCount(steps.length)}</span>
        {changed && <DiffStat diff={changed} />}
        {running && <span className="status-dot working" aria-label="Running" />}
        {failed && <ExclamationCircleIcon className="step-error" aria-label="A step failed" />}
      </summary>
      <ol>
        {steps.map((step) => (
          <li key={step.id}>
            <StepDetails step={step} now={now} />
          </li>
        ))}
      </ol>
    </details>
  );
}

/** One row per tool call, collapsed to a single line until the user opens it. */
function StepDetails({ step, now }: { step: Step; now: number }) {
  const disclosure = useDisclosure(`step-${step.id}`, false);
  const output = useMemo(() => formatToolOutput(step.output), [step.output]);
  const failed = step.status === "error" || output.exitCode !== undefined || output.failed;
  const elapsed = stepElapsed(step, now);

  return (
    <details className="step" {...disclosure}>
      <summary title={step.detail || undefined}>
        <StepIcon name={step.name} status={step.status} failed={Boolean(failed)} />
        <span className="step-name">{step.name}</span>
        {step.file ? (
          <FileLabel prefix={step.file.prefix} path={step.file.path} />
        ) : (
          step.detail && <code className="step-detail">{oneLine(step.detail)}</code>
        )}
        {step.diff && <DiffStat diff={step.diff} />}
        {output.exitCode !== undefined && <span className="step-exit">exit {output.exitCode}</span>}
        {elapsed && <span className="step-time">{elapsed}</span>}
      </summary>
      <div className="step-body">
        {output.sections.length ? (
          <pre className="step-output">
            {output.sections.map((section, index) => (
              <span key={index} className={`output-${section.kind}`}>
                {section.text}
              </span>
            ))}
          </pre>
        ) : (
          <p className="step-placeholder">{stepPlaceholder(step.status)}</p>
        )}
        {step.images?.map((src) => (
          <a key={src} href={src} target="_blank" rel="noreferrer">
            <img
              src={src}
              alt="Browser Run screenshot"
              loading="lazy"
              style={{ maxWidth: "100%", height: "auto" }}
            />
          </a>
        ))}
      </div>
    </details>
  );
}

function stepElapsed(step: Step, now: number) {
  if (step.startedAt === undefined) return "";

  const end = step.endedAt ?? (step.status === "running" ? now : undefined);

  if (end === undefined) return "";

  const ms = Math.max(0, end - step.startedAt);

  return ms < 1000 ? "<1s" : duration(ms);
}

/** Lines added and removed, as `+12 -3`; zero counts are left out. */
function DiffStat({ diff }: { diff: DiffStats }) {
  if (diff.added === 0 && diff.removed === 0) return null;

  return (
    <span
      className="diff-stat"
      aria-label={`${diff.added} ${diff.added === 1 ? "line" : "lines"} added, ${diff.removed} removed`}
    >
      {diff.added > 0 && <span className="diff-added">+{diff.added}</span>}
      {diff.removed > 0 && <span className="diff-removed">-{diff.removed}</span>}
    </span>
  );
}

const toolIcons = new Map(
  Object.entries({
    shell: CommandLineIcon,
    bash: CommandLineIcon,
    read_file: DocumentTextIcon,
    edit: PencilIcon,
    write: PencilIcon,
    edit_file: PencilIcon,
    write_file: PencilIcon,
    github: CodeBracketIcon,
    workspace: FolderIcon,
    preview: EyeIcon,
    spawn_task: UsersIcon,
    send_to_session: UsersIcon,
    list_children: UsersIcon,
    task_status: UsersIcon,
    cancel_task: UsersIcon,
    schedule_prompt: ClockIcon,
    list_scheduled_prompts: ClockIcon,
    cancel_scheduled_prompt: ClockIcon,
    wait_for: CheckBadgeIcon,
    cancel_wait: CheckBadgeIcon,
  }),
);

/** The tool's icon, tinted by status: amber while running, red on failure. */
function StepIcon({
  name,
  status,
  failed,
}: {
  name: string;
  status: Step["status"];
  failed: boolean;
}) {
  const Icon = toolIcons.get(name) ?? WrenchIcon;
  const state = status === "running" || status === "pending" ? status : failed ? "error" : "done";

  const label = { running: "Running", pending: "Queued", error: "Failed", done: "Done" }[state];

  return <Icon className={`step-status step-${state}`} aria-label={label} />;
}

/** A file path as a type badge, a dimmed directory and the file name. */
function FileLabel({ prefix, path }: { prefix: string; path: string }) {
  const slash = path.lastIndexOf("/");
  const directory = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";

  return (
    <span className="step-file">
      {prefix && <code className="step-file-prefix">{prefix}</code>}
      {extension && (
        <span className={`file-badge file-${fileKind(extension)}`}>{extension.toUpperCase()}</span>
      )}
      <span className="step-file-path">
        {directory && <span className="step-file-dir">{directory}</span>}
        <span className="step-file-name">{name}</span>
      </span>
    </span>
  );
}

const fileKinds: Record<string, string> = Object.fromEntries(
  Object.entries({
    ts: ["ts", "tsx", "mts", "cts"],
    js: ["js", "jsx", "mjs", "cjs"],
    sh: ["sh", "bash", "zsh"],
    data: ["json", "jsonc", "yml", "yaml", "toml"],
    style: ["css", "scss", "html"],
  }).flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind])),
);

function fileKind(extension: string) {
  return fileKinds[extension] ?? "other";
}

function stepPlaceholder(status: Step["status"]) {
  switch (status) {
    case "running":
      return "Running…";
    case "pending":
      return "Queued";
    default:
      return "No output";
  }
}

function Answer({ id, text, at, now }: { id: string; text: string; at?: number; now: number }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <article className="answer" aria-label="assistant message" data-message={id}>
      <Prose text={text} />
      <div className="answer-actions">
        {at !== undefined && <time dateTime={new Date(at).toISOString()}>{ago(at, now)}</time>}
        <IconButton label={copied ? "Message copied" : "Copy message"} onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <DocumentDuplicateIcon />}
        </IconButton>
        {copyError && (
          <span role="status" className="error-text">
            Could not copy. Select the text instead.
          </span>
        )}
      </div>
    </article>
  );
}

export function Composer({
  onSend,
  onStop,
  pending,
  running,
  modelControl,
  draftKey,
  queued,
  onSteerQueued,
  onEditQueued,
  onDeleteQueued,
  onReorderQueue,
  activity,
}: {
  onSend: (
    content: string,
    requestId: string,
    attachments: readonly Attachment[],
    steer: boolean,
  ) => Promise<boolean>;
  onStop: () => void;
  pending: boolean;
  running: boolean;
  /** The session's model pill (`ModelControl`), owned by the workspace. */
  modelControl: ReactNode;
  draftKey: string;
  /** Messages waiting for the next turn; steers already show in the conversation. */
  queued: readonly QueuedMessage[];
  onSteerQueued: (id: number) => void;
  /**
   * Withdraws a queued message for editing and resolves with its original text, or "refused"
   * when the server answered that it can't (it
   * was already delivered, or isn't the owner's text), "unknown" when no answer came back.
   */
  onEditQueued: (id: number) => Promise<{ content: string } | "refused" | "unknown">;
  onDeleteQueued: (id: number) => void;
  onReorderQueue: (order: readonly number[]) => Promise<boolean>;
  /** Changes as the conversation moves, so "send later" picks up schedules the agent makes. */
  activity: number;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [retry, setRetry] = useState<{
    content: string;
    requestId: string;
    session: string;
    attachments: readonly Attachment[];
  } | null>(null);

  const [images, setImages] = useState<Record<string, Attachment[]>>({});
  const [attachError, setAttachError] = useState("");
  const content = drafts[draftKey] ?? "";
  const attachments = images[draftKey] ?? [];
  const field = useRef<HTMLTextAreaElement>(null);

  const setAttachments = (next: Attachment[]) =>
    setImages((values) => ({ ...values, [draftKey]: next }));

  const input = useAttachmentInput(attachments, setAttachments, setAttachError, pending);

  // While a run works, Enter (and the send button) does the chosen action and ⌘/Ctrl+Enter the other.
  const [busySend, setBusySend] = useState<BusySend>("queue");
  const [modifierHeld, setModifierHeld] = useState(false);
  const [sendMenu, setSendMenu] = useState(false);
  const sendRoot = useRef<HTMLDivElement>(null);
  const longPress = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pressedLong = useRef(false);

  useEffect(() => {
    setBusySend(readBusySend());

    return onBusySendChanged(setBusySend);
  }, []);

  useEffect(() => {
    const sync = (event: KeyboardEvent) => setModifierHeld(event.metaKey || event.ctrlKey);
    const clear = () => setModifierHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);

    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    if (!sendMenu) return;

    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !sendRoot.current?.contains(event.target))
        setSendMenu(false);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSendMenu(false);
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [sendMenu]);

  /** Whether a send made now, with or without the modifier, steers the running turn. */
  const steers = (modifier: boolean) =>
    running && (modifier ? otherBusySend(busySend) : busySend) === "steer";

  const steerSend = steers(modifierHeld);
  const modGlyph = modEnterGlyph();

  function pickBusySend(value: BusySend) {
    saveBusySend(value);
    setSendMenu(false);
  }

  // Escape twice while a run works stops it: the first press arms, a second within the window stops.
  const escArmed = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!running) {
      clearTimeout(escArmed.current);
      escArmed.current = undefined;
    }
  }, [running]);

  useEffect(() => () => clearTimeout(escArmed.current), []);

  function escape() {
    if (escArmed.current) {
      clearTimeout(escArmed.current);
      escArmed.current = undefined;
      onStop();

      return;
    }

    escArmed.current = setTimeout(() => {
      escArmed.current = undefined;
    }, ESC_STOP_WINDOW_MS);
  }

  async function edit(id: number) {
    const item = queued.find((candidate) => candidate.id === id);

    if (!item) return;

    // The text goes into the draft before the server withdraws it, so a lost response never
    // loses the message. Only a definite refusal takes it back out.
    const before = drafts[draftKey] ?? "";
    const after = before.trim() ? `${before}\n\n${item.text}` : item.text;

    setDrafts((values) => ({ ...values, [draftKey]: after }));
    field.current?.focus();

    const result = await onEditQueued(id);

    if (result === "unknown") return;

    // The preview is redacted like the transcript; the server returns the original text.
    const restored =
      result === "refused"
        ? before
        : before.trim()
          ? `${before}\n\n${result.content}`
          : result.content;

    setDrafts((values) =>
      values[draftKey] === after ? { ...values, [draftKey]: restored } : values,
    );
  }

  async function submit(steer: boolean) {
    if ((!content.trim() && !attachments.length) || pending || input.reading) return;

    const requestId =
      retry?.content === content &&
      retry.session === draftKey &&
      retry.attachments.length === attachments.length &&
      retry.attachments.every((image, index) => image.id === attachments[index]?.id)
        ? retry.requestId
        : crypto.randomUUID();

    // A retry of the same draft reuses its request ID even if queue/steer changed meanwhile (the run
    // ended, or another key was used), so a send the server already took is never taken twice.
    setRetry({ content, requestId, session: draftKey, attachments });

    if (await onSend(content, requestId, attachments, steer)) {
      setDrafts((values) => ({ ...values, [draftKey]: "" }));
      setImages((values) => ({ ...values, [draftKey]: [] }));
      setAttachError("");
      setRetry(null);
    }
  }

  const hasDraft = Boolean(content.trim() || attachments.length);

  return (
    <div className="composer-area">
      <div className={queued.length > 0 ? "composer-shell has-queue" : "composer-shell"}>
        <CiWaitStrip session={draftKey} activity={activity} />
        <MessageQueue
          queued={queued}
          disabled={pending}
          onSteer={onSteerQueued}
          onEdit={(id) => void edit(id)}
          onDelete={onDeleteQueued}
          onReorder={onReorderQueue}
        />
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(steerSend);
          }}
          onDragOver={input.onDragOver}
          onDrop={input.onDrop}
        >
          <AttachmentTray
            attachments={attachments}
            disabled={pending || input.reading}
            onRemove={(id) => setAttachments(attachments.filter((item) => item.id !== id))}
          />
          <label className="sr-only" htmlFor="prompt">
            Message your agent
          </label>
          <Textarea
            id="prompt"
            name="prompt"
            ref={field}
            rows={1}
            placeholder={running ? "Queue for when it finishes…" : "Ask dolly…"}
            value={content}
            maxLength={32768}
            disabled={pending}
            onChange={(event) => setDrafts({ ...drafts, [draftKey]: event.target.value })}
            onPaste={input.onPaste}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;

              if (event.key === "Escape" && running && !event.repeat) {
                event.preventDefault();
                escape();

                return;
              }

              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit(steers(event.metaKey || event.ctrlKey));
              }
            }}
          />
          <div className="composer-toolbar">
            <AttachButton
              disabled={pending || input.reading}
              count={attachments.length}
              onFiles={(files) => void input.add(files)}
            />
            <ScheduleButton
              session={draftKey}
              draft={content}
              disabled={pending}
              activity={activity}
              unavailable={
                attachments.length
                  ? "Screenshots can't be sent later; remove them first"
                  : undefined
              }
              onScheduled={() => setDrafts((values) => ({ ...values, [draftKey]: "" }))}
            />
            {modelControl}
            {running && (
              <button
                type="button"
                className="round-button stop"
                aria-label="Stop agent"
                title="Stop. Interrupts the current turn (Esc twice)"
                disabled={pending}
                onClick={onStop}
              >
                <StopIcon />
              </button>
            )}
            {(!running || hasDraft) && (
              <div className="send-control" ref={sendRoot}>
                <button
                  type="submit"
                  className={`round-button send${running ? (steerSend ? " steer" : " queue") : ""}`}
                  disabled={!hasDraft || pending || input.reading}
                  aria-label={
                    running
                      ? steerSend
                        ? "Steer into the running turn"
                        : "Queue until the current turn finishes"
                      : "Send message"
                  }
                  title={
                    running
                      ? `${steerSend ? "Steer message" : "Queue message"} (${
                          modifierHeld ? modGlyph : "↵"
                        }). Right-click or hold for options`
                      : "Send (↵). Right-click or hold for options"
                  }
                  aria-haspopup="menu"
                  aria-expanded={sendMenu}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setSendMenu(true);
                  }}
                  onPointerDown={(event) => {
                    if (event.pointerType === "mouse") return;
                    pressedLong.current = false;
                    clearTimeout(longPress.current);
                    longPress.current = setTimeout(() => {
                      pressedLong.current = true;
                      setSendMenu(true);
                    }, LONG_PRESS_MS);
                  }}
                  onPointerUp={() => clearTimeout(longPress.current)}
                  onPointerLeave={() => clearTimeout(longPress.current)}
                  onClick={(event) => {
                    // A long press opened the menu; it doesn't also send.
                    if (pressedLong.current) {
                      event.preventDefault();
                      pressedLong.current = false;
                    }
                  }}
                >
                  {running && !steerSend ? <ArrowTurnDownLeftIcon /> : <ArrowUpIcon />}
                </button>
                {sendMenu && (
                  <div className="send-menu" role="menu" aria-label="While the agent is working">
                    <p className="schedule-heading">While the agent is working</p>
                    {(["queue", "steer"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={busySend === value}
                        className="picker-action"
                        onClick={() => pickBusySend(value)}
                      >
                        {value === "queue" ? (
                          <ArrowTurnDownLeftIcon className="picker-icon" aria-hidden="true" />
                        ) : (
                          <ArrowUpIcon className="picker-icon" aria-hidden="true" />
                        )}
                        <span className="picker-label">
                          {value === "queue"
                            ? "Queue after run finishes"
                            : "Steer into running turn"}
                        </span>
                        <span className="picker-hint">{busySend === value ? "↵" : modGlyph}</span>
                        <CheckIcon
                          className="picker-check"
                          aria-hidden="true"
                          style={{ visibility: busySend === value ? "visible" : "hidden" }}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </form>
      </div>
      {attachError && (
        <p role="alert" className="error-text">
          {attachError}
        </p>
      )}
    </div>
  );
}
