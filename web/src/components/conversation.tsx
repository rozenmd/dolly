import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
  StopIcon,
} from "@heroicons/react/16/solid";
import { DocumentDuplicateIcon, Square2StackIcon } from "@heroicons/react/24/outline";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { QueuedMessage, Step, Turn } from "../lib/api";
import { ago, duration } from "../lib/time";
import { IconButton, Textarea } from "./ui";
import { AttachButton, AttachmentTray, useAttachmentInput } from "./attachments";
import type { Attachment } from "../lib/images";

function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

export function Conversation({
  turns,
  sessionId,
  loading,
}: {
  turns: readonly Turn[];
  sessionId: string;
  loading: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const now = Date.now();

  useLayoutEffect(() => {
    pinned.current = true;
  }, [sessionId]);
  useLayoutEffect(() => {
    if (pinned.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [turns]);

  return (
    <div
      className="conversation-scroll"
      ref={scroll}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
      }}
    >
      <div className="conversation-content">
        {loading && turns.length === 0 && (
          <p className="conversation-status" role="status">
            Loading conversation…
          </p>
        )}
        {!loading && turns.length === 0 && (
          <p className="conversation-status">Send a message to start.</p>
        )}
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} now={now} />
        ))}
      </div>
    </div>
  );
}

function TurnView({ turn, now }: { turn: Turn; now: number }) {
  const started = turn.prompt?.at ?? turn.startedAt;

  return (
    <section className="turn">
      {turn.prompt && (
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
      {turn.items.length > 0 && <WorkLog turn={turn} />}
      {turn.answer && (
        <Answer id={turn.answer.id} text={turn.answer.text} at={turn.endedAt} now={now} />
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
          Working{started !== undefined && <> · {duration(Math.max(0, now - started))}</>}
        </p>
      )}
    </section>
  );
}

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

function WorkLog({ turn }: { turn: Turn }) {
  const started = turn.prompt?.at ?? turn.startedAt;

  const elapsed =
    started !== undefined && turn.endedAt !== undefined ? duration(turn.endedAt - started) : "";

  return (
    <details className="work-log" open={turn.running || Boolean(turn.failure)}>
      <summary>
        <ChevronRightIcon className="disclosure" />
        <span className="work-label">{turn.running ? "Working" : "Worked"}</span>
        <span className="work-meta">
          {[!turn.running && elapsed, stepCount(turn.steps)].filter(Boolean).join(" · ")}
        </span>
      </summary>
      <div className="work-timeline">
        {turn.items.map((item) =>
          item.kind === "text" ? (
            <Prose key={item.id} text={item.text} />
          ) : (
            <StepGroup key={item.id} steps={item.steps} />
          ),
        )}
      </div>
    </details>
  );
}

function stepCount(count: number) {
  return count === 0 ? "" : `${count} ${count === 1 ? "step" : "steps"}`;
}

function StepGroup({ steps }: { steps: readonly Step[] }) {
  const running = steps.some((step) => step.status === "running");
  const failed = steps.some((step) => step.status === "error");

  return (
    <details className="step-group">
      <summary>
        <Square2StackIcon />
        <span>{stepCount(steps.length)}</span>
        {running && <span className="status-dot working" aria-label="Running" />}
        {failed && <ExclamationCircleIcon className="step-error" aria-label="A step failed" />}
      </summary>
      <ol>
        {steps.map((step) => (
          <li key={step.id}>
            <details className="step">
              <summary>
                <span className={`step-name step-${step.status}`}>{step.name}</span>
                {step.detail && <code>{step.detail}</code>}
              </summary>
              <pre>{step.output || (step.status === "running" ? "Running…" : "No output")}</pre>
            </details>
          </li>
        ))}
      </ol>
    </details>
  );
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
  model,
  draftKey,
  queued,
  onSteerQueued,
}: {
  onSend: (
    content: string,
    requestId: string,
    attachments: readonly Attachment[],
  ) => Promise<boolean>;
  onStop: () => void;
  pending: boolean;
  running: boolean;
  model: string;
  draftKey: string;
  queued: readonly QueuedMessage[];
  onSteerQueued: (id: number) => void;
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

  const setAttachments = (next: Attachment[]) =>
    setImages((values) => ({ ...values, [draftKey]: next }));

  const input = useAttachmentInput(attachments, setAttachments, setAttachError);

  async function submit(event: FormEvent) {
    event.preventDefault();

    if (!content.trim() || pending) return;

    const requestId =
      retry?.content === content && retry.session === draftKey && retry.attachments === attachments
        ? retry.requestId
        : crypto.randomUUID();

    setRetry({ content, requestId, session: draftKey, attachments });

    if (await onSend(content, requestId, attachments)) {
      setDrafts((values) => ({ ...values, [draftKey]: "" }));
      setImages((values) => ({ ...values, [draftKey]: [] }));
      setAttachError("");
      setRetry(null);
    }
  }

  return (
    <div className="composer-area">
      {queued.length > 0 && (
        <section className="message-queue" aria-label="Queued messages">
          <h2>Queued messages</h2>
          <ul>
            {queued.map((item) => (
              <li key={item.id}>
                <p>{item.text}</p>
                {item.steering ? (
                  <span role="status">Sending after the current step…</span>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    title="Deliver after the current step instead of waiting for the answer"
                    onClick={() => onSteerQueued(item.id)}
                  >
                    <ArrowUpIcon />
                    Send now
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <form
        className="composer"
        onSubmit={(event) => void submit(event)}
        onDragOver={input.onDragOver}
        onDrop={input.onDrop}
      >
        <AttachmentTray
          attachments={attachments}
          disabled={pending}
          onRemove={(id) => setAttachments(attachments.filter((item) => item.id !== id))}
        />
        <label className="sr-only" htmlFor="prompt">
          Message your agent
        </label>
        <Textarea
          id="prompt"
          name="prompt"
          rows={1}
          placeholder={running ? "Queue for when it finishes…" : "Ask dolly…"}
          value={content}
          maxLength={32768}
          disabled={pending}
          onChange={(event) => setDrafts({ ...drafts, [draftKey]: event.target.value })}
          onPaste={input.onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-toolbar">
          <AttachButton
            disabled={pending}
            count={attachments.length}
            onFiles={(files) => void input.add(files)}
          />
          <span className="composer-model">{model}</span>
          {running && !content.trim() ? (
            <button
              type="button"
              className="round-button stop"
              aria-label="Stop agent"
              disabled={pending}
              onClick={onStop}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="round-button send"
              disabled={!content.trim() || pending}
              aria-label={running ? "Queue message" : "Send message"}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </form>
      {attachError && (
        <p role="alert" className="error-text">
          {attachError}
        </p>
      )}
    </div>
  );
}
