import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardIcon,
  CodeBracketIcon,
  CommandLineIcon,
  StopIcon,
} from "@heroicons/react/16/solid";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../lib/api";
import { IconButton, Textarea } from "./ui";

export function Conversation({
  messages,
  preview,
  previewPrimary,
  title,
  loading,
}: {
  messages: readonly ChatMessage[];
  preview: boolean;
  previewPrimary: boolean;
  title: string;
  loading: boolean;
}) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    pinned.current = true;
  }, [title]);
  useLayoutEffect(() => {
    if (!preview && pinned.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, preview]);

  async function copy(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(message.id);
      setCopyError("");
    } catch {
      setCopyError("Could not copy. Select the message text to copy it manually.");
    }
  }

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
        <div className="conversation-date">
          <span />
          {preview ? "Example conversation" : "Session transcript"}
          <span />
        </div>
        {loading && messages.length === 0 && (
          <p className="empty-message" role="status">
            Loading conversation…
          </p>
        )}
        {!loading && messages.length === 0 && (
          <div className="conversation-empty">
            <CommandLineIcon />
            <h2>{title}</h2>
            <p>
              Give your agent a task. It can explore your code, run tests, and prepare a pull
              request.
            </p>
          </div>
        )}
        {messages.map((message, index) => (
          <article
            key={message.id}
            className={`message message-${message.role}`}
            aria-label={`${message.role} message`}
          >
            {previewPrimary && index === 1 && (
              <WorkLog label="Worked for 6 minutes" steps="3 steps" />
            )}
            {previewPrimary && index === 2 && (
              <WorkLog label="Worked for 5 minutes" steps="1 step" />
            )}
            {message.role === "toolResult" ? (
              <details className="tool-result">
                <summary>
                  <CommandLineIcon />
                  {message.toolName ?? "Tool output"}
                </summary>
                <pre>{message.text}</pre>
              </details>
            ) : (
              <>
                {message.role !== "user" && (
                  <div className="agent-label">
                    <span className="agent-symbol">π</span>
                    <strong>pi-hard</strong>
                    <span>Agent</span>
                  </div>
                )}
                <div className="message-body prose">
                  <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
                </div>
                {message.role !== "user" && (
                  <div className="message-actions">
                    <span>{preview ? "Example response" : "Agent response"}</span>
                    <IconButton
                      label={copied === message.id ? "Message copied" : "Copy message"}
                      onClick={() => void copy(message)}
                    >
                      {copied === message.id ? <CheckIcon /> : <ClipboardIcon />}
                    </IconButton>
                  </div>
                )}
              </>
            )}
          </article>
        ))}
        {copyError && (
          <p role="status" className="error-text">
            {copyError}
          </p>
        )}
      </div>
    </div>
  );
}

function WorkLog({ label, steps }: { label: string; steps: string }) {
  return (
    <details className="work-log">
      <summary>
        <ChevronRightIcon />
        <span>{label}</span>
        <span className="muted">· {steps}</span>
        <CheckIcon className="success" />
      </summary>
      <div>
        <p>
          <CodeBracketIcon /> Inspected workspace and updated the implementation
        </p>
        <p>
          <CheckIcon /> Ran focused tests successfully
        </p>
        <p className="muted">Illustrative activity, not a live agent run.</p>
      </div>
    </details>
  );
}

export function Composer({
  onSend,
  onStop,
  pending,
  preview,
  onConnect,
  model,
  draftKey,
}: {
  onSend: (content: string, requestId: string) => Promise<boolean>;
  onStop: () => void;
  pending: boolean;
  preview: boolean;
  onConnect: () => void;
  model: string;
  draftKey: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [retry, setRetry] = useState<{
    content: string;
    requestId: string;
    session: string;
  } | null>(null);

  const content = drafts[draftKey] ?? "";

  async function submit(event: FormEvent) {
    event.preventDefault();

    if (preview) {
      onConnect();

      return;
    }

    if (!content.trim() || pending) return;

    const requestId =
      retry?.content === content && retry.session === draftKey
        ? retry.requestId
        : crypto.randomUUID();

    setRetry({ content, requestId, session: draftKey });

    if (await onSend(content, requestId)) {
      setDrafts((values) => ({ ...values, [draftKey]: "" }));
      setRetry(null);
    }
  }

  return (
    <div className="composer-area">
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <label className="sr-only" htmlFor="prompt">
          Message your agent
        </label>
        <Textarea
          id="prompt"
          name="prompt"
          placeholder={preview ? "What would you like to build?" : "Ask your agent…"}
          value={content}
          maxLength={32768}
          disabled={pending}
          onChange={(event) => setDrafts({ ...drafts, [draftKey]: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-context">
            <CodeBracketIcon />
            <span>{model}</span>
            <span className="context-divider" />
            <span>Workspace agent</span>
          </div>
          <div className="composer-controls">
            {!preview && (
              <IconButton label="Stop agent" onClick={onStop} disabled={pending || !draftKey}>
                <StopIcon />
              </IconButton>
            )}
            <button
              type="submit"
              className="send-button"
              disabled={!preview && (!content.trim() || pending)}
              aria-label={preview ? "Connect to start chatting" : "Send message"}
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      </form>
      <div className="composer-hint">
        <span>
          {preview
            ? "Preview mode. Connect your API to start a real session."
            : "Enter to send · Shift + Enter for a new line"}
        </span>
        <span className="durable-caption">
          <span className="tiny-dot" /> Durable sessions
        </span>
      </div>
    </div>
  );
}
