import { useEffect, useRef, useState } from "react";
import { ArrowTopRightOnSquareIcon, CheckIcon } from "@heroicons/react/16/solid";
import { DocumentDuplicateIcon } from "@heroicons/react/24/outline";
import { codexLogin, type CodexStatus } from "../lib/api";
import { duration } from "../lib/time";

/** Consecutive failed status checks before polling stops and asks the person to retry. */
const maxPollFailures = 5;

/**
 * ChatGPT device sign-in: show the one-time code and a link to enter it, then
 * poll the Worker until it reports the subscription connected. Reopening the
 * dialog resumes a code that is still valid instead of issuing a new one.
 */
export function CodexLogin({
  token,
  onConnected,
  onCancel,
}: {
  token: string;
  onConnected: () => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [paused, setPaused] = useState(false);
  const failures = useRef(0);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  function apply(next: CodexStatus) {
    failures.current = 0;
    setStatus(next);
    setError("");

    if (next.state === "connected") connected.current();
  }

  async function start() {
    setPending(true);
    setError("");
    setPaused(false);

    try {
      apply(await codexLogin(token, "POST"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start ChatGPT sign-in.");
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setPending(true);

    try {
      await codexLogin(token, "DELETE");
    } catch {
      // The pending code expires on its own; closing the dialog is what matters here.
    } finally {
      setPending(false);
      onCancel();
    }
  }

  useEffect(() => {
    let active = true;

    codexLogin(token).then(
      (next) => active && apply(next),
      (cause) =>
        active &&
        setError(cause instanceof Error ? cause.message : "Could not check ChatGPT sign-in."),
    );

    return () => {
      active = false;
    };
  }, [token]);

  const awaiting = status?.state === "awaiting_code" ? status : null;

  useEffect(() => {
    if (!awaiting || paused) return;

    let active = true;
    const delay = Math.min(30, Math.max(1, awaiting.pollAfterSeconds)) * 1000;

    const timer = setTimeout(() => {
      codexLogin(token).then(
        (next) => active && apply(next),
        (cause) => {
          if (!active) return;

          failures.current += 1;

          if (failures.current >= maxPollFailures) {
            setPaused(true);
            setError(cause instanceof Error ? cause.message : "Could not check ChatGPT sign-in.");
          } else setStatus({ ...awaiting });
        },
      );
    }, delay);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [awaiting, paused, token]);

  if (!status)
    return (
      <div className="codex-login">
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : (
          <p className="muted" role="status">
            Checking ChatGPT…
          </p>
        )}
      </div>
    );

  if (awaiting)
    return (
      <div className="codex-login">
        <p className="muted">
          Enter this code at{" "}
          <strong className="codex-host">
            {awaiting.verificationUri.replace(/^https:\/\//, "")}
          </strong>
        </p>
        <div className="codex-code-row">
          <DeviceCode code={awaiting.userCode} />
          <a
            className="primary-button"
            href={awaiting.verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            Open ChatGPT
            <ArrowTopRightOnSquareIcon />
          </a>
        </div>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="codex-waiting">
          {paused ? (
            <button type="button" className="secondary-button" onClick={() => setPaused(false)}>
              Check again
            </button>
          ) : (
            <span role="status">
              <span className="status-dot working pulse" />
              Waiting for ChatGPT. Approve there, then come back here.
            </span>
          )}
          <button
            type="button"
            className="ghost-button"
            disabled={pending}
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        </div>
        <p className="field-help">
          Code expires in {duration(Math.max(0, awaiting.expiresAt - Date.now()))}.
        </p>
      </div>
    );

  return (
    <div className="codex-login">
      <p className="muted">
        {status.state === "expired"
          ? "That code expired before it was approved."
          : "Sign in with the ChatGPT account whose Codex subscription runs your agents."}
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button
          type="button"
          className="primary-button"
          disabled={pending}
          onClick={() => void start()}
        >
          {pending
            ? "Getting a code…"
            : status.state === "expired"
              ? "Get a new code"
              : "Sign in with ChatGPT"}
        </button>
      </div>
    </div>
  );
}

function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="device-code"
      aria-label={copied ? `Copied code ${code}` : `Copy code ${code}`}
      title={copied ? "Copied" : "Copy code"}
      onClick={() =>
        void navigator.clipboard.writeText(code).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      <span>{code}</span>
      {copied ? <CheckIcon /> : <DocumentDuplicateIcon />}
    </button>
  );
}
