import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/16/solid";
import { chatgptLogin, completeChatGPTLogin, type ChatGPTStatus } from "../lib/api";
import { duration } from "../lib/time";
import { Input } from "./ui";

/**
 * Sign in with ChatGPT. Approving registers Dolly as a connected app on the ChatGPT account.
 * ChatGPT then redirects to a local address that does not load, because Dolly runs in the
 * cloud; the owner pastes that address here to finish. Reopening resumes a pending attempt.
 */
export function ChatGPTLogin({
  onConnected,
  onCancel,
}: {
  onConnected: () => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<ChatGPTStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  // Set synchronously on Cancel so a response already in flight cannot report a sign-in.
  const cancelled = useRef(false);
  const connected = useRef(onConnected);
  connected.current = onConnected;

  function apply(next: ChatGPTStatus) {
    if (cancelled.current) return;

    setStatus(next);
    setError("");

    if (next.state === "connected") connected.current();
  }

  async function start() {
    setPending(true);
    setError("");

    try {
      apply(await chatgptLogin("POST"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start ChatGPT sign-in.");
    } finally {
      setPending(false);
    }
  }

  async function finish(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      apply(await completeChatGPTLogin(callbackUrl.trim()));
    } catch (cause) {
      if (cancelled.current) return;
      setError(cause instanceof Error ? cause.message : "Could not finish ChatGPT sign-in.");
      // A rejected code ends the attempt on the Worker; reflect whether it is still pending.
      chatgptLogin().then(
        (next) => !cancelled.current && setStatus(next),
        () => {},
      );
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    cancelled.current = true;
    setCancelling(true);

    try {
      await chatgptLogin("DELETE");
    } catch {
      // The pending attempt expires on its own; closing the dialog is what matters here.
    } finally {
      setCancelling(false);
      onCancel();
    }
  }

  useEffect(() => {
    let active = true;

    chatgptLogin().then(
      (next) => active && apply(next),
      (cause) =>
        active &&
        setError(cause instanceof Error ? cause.message : "Could not check ChatGPT sign-in."),
    );

    return () => {
      active = false;
    };
  }, []);

  if (!status)
    return (
      <div className="chatgpt-login">
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

  if (status.state === "awaiting_redirect")
    return (
      <div className="chatgpt-login">
        <ol className="chatgpt-steps">
          <li>
            <span>Approve Dolly in ChatGPT.</span>
            <a
              className="primary-button"
              href={status.authorizeUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open ChatGPT
              <ArrowTopRightOnSquareIcon />
            </a>
          </li>
          <li>
            <span>
              ChatGPT then opens a page at{" "}
              <strong className="chatgpt-host">
                {status.redirectUri.replace(/^http:\/\//, "")}
              </strong>{" "}
              that won't load. Copy its full address and paste it here.
            </span>
          </li>
        </ol>
        <form className="chatgpt-callback" onSubmit={(event) => void finish(event)}>
          <label htmlFor="chatgpt-callback">Address of the page that didn't load</label>
          <Input
            id="chatgpt-callback"
            type="url"
            placeholder={`${status.redirectUri}?code=…`}
            autoComplete="off"
            spellCheck={false}
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
          />
          <button
            type="submit"
            className="primary-button"
            disabled={pending || !callbackUrl.trim()}
          >
            {pending ? "Connecting…" : "Connect"}
          </button>
        </form>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="chatgpt-footer">
          <p className="field-help">
            Sign-in expires in {duration(Math.max(0, status.expiresAt - Date.now()))}.
          </p>
          <button
            type="button"
            className="ghost-button"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <div className="chatgpt-login">
      <p className="muted">
        {status.state === "expired"
          ? "That sign-in expired before it finished."
          : "Connect Dolly as an app on your ChatGPT account. Agents use your plan, within the limit you set for Dolly under Connected App Limits in ChatGPT."}
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
            ? "Starting…"
            : status.state === "expired"
              ? "Start again"
              : "Sign in with ChatGPT"}
        </button>
      </div>
    </div>
  );
}
