import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/16/solid";
import * as Schema from "effect/Schema";
import { githubSignIn, request, RequestError, type GitHubSignIn as SignInStatus } from "../lib/api";
import { duration } from "../lib/time";
import { DeviceCode, Input } from "./ui";

/** Consecutive failed status checks before polling stops and asks the person to retry. */
const maxPollFailures = 5;

/** The ingress Worker's webhook URL from whatever the person pasted: a base URL or the full hook. */
export function ingressHook(value: string) {
  const base = value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/hooks\/github$/, "");

  return base ? `${base}/hooks/github` : "";
}

/** Creates the GitHub App from a manifest. GitHub fills in every setting, including the webhook. */
export function GitHubSetup({ initialError }: { initialError: string }) {
  const [ownerType, setOwnerType] = useState<"personal" | "organization">("personal");
  const [owner, setOwner] = useState("");
  const [ingress, setIngress] = useState("");
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      const text = await request("/integrations/github/setup", {
        owner: owner.trim(),
        ownerType,
        ingress: ingressHook(ingress),
      });

      const result = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ setupUrl: Schema.NullOr(Schema.String) })),
      )(text);

      if (result.setupUrl) window.location.assign(result.setupUrl);
      else window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start GitHub App setup.");
      setPending(false);
    }
  }

  return (
    <form className="gate-form" onSubmit={(event) => void submit(event)}>
      <p className="muted">
        dolly signs you in and works on your repositories through a GitHub App that you own. GitHub
        creates it with everything filled in.
      </p>
      <fieldset className="segmented">
        <legend className="sr-only">Who owns the GitHub App</legend>
        <label>
          <input
            type="radio"
            name="ownerType"
            checked={ownerType === "personal"}
            onChange={() => setOwnerType("personal")}
          />
          Personal account
        </label>
        <label>
          <input
            type="radio"
            name="ownerType"
            checked={ownerType === "organization"}
            onChange={() => setOwnerType("organization")}
          />
          Organization
        </label>
      </fieldset>
      <label htmlFor="github-owner">
        {ownerType === "personal" ? "Your GitHub username" : "Organization name"}
      </label>
      <Input
        id="github-owner"
        name="owner"
        autoComplete="off"
        required
        pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,99}"
        value={owner}
        onChange={(event) => setOwner(event.target.value)}
      />
      <label htmlFor="github-ingress">Ingress URL</label>
      <Input
        id="github-ingress"
        name="ingress"
        type="url"
        required
        placeholder="https://dolly-ingress.example.workers.dev"
        value={ingress}
        onChange={(event) => setIngress(event.target.value)}
        aria-describedby="github-ingress-help"
      />
      <p id="github-ingress-help" className="field-help">
        The URL of your deployed dolly-ingress Worker. GitHub sends issue and pull request comments
        there.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <button type="submit" className="primary-button" disabled={pending}>
        {pending ? "Opening GitHub…" : "Create GitHub App"}
      </button>
    </form>
  );
}

/** GitHub device sign-in: show the one-time code, then poll until GitHub approves it. */
export function GitHubSignIn({
  settingsUrl,
  firstRun,
  onSignedIn,
}: {
  settingsUrl: string;
  firstRun: boolean;
  onSignedIn: (login: string) => void;
}) {
  const [status, setStatus] = useState<SignInStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [paused, setPaused] = useState(false);
  const [deviceFlowOff, setDeviceFlowOff] = useState(false);
  const failures = useRef(0);
  // Bumped on Cancel and on each new start, so answers to an abandoned attempt are ignored.
  const attempt = useRef(0);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  function apply(next: SignInStatus, id: number) {
    if (id !== attempt.current) return;

    failures.current = 0;
    setStatus(next);
    setError("");

    if (next.state === "signed_in") signedIn.current(next.login);
  }

  async function start() {
    const id = ++attempt.current;
    setPending(true);
    setError("");
    setPaused(false);
    setDeviceFlowOff(false);

    try {
      apply(await githubSignIn("POST"), id);
    } catch (cause) {
      if (id !== attempt.current) return;

      setDeviceFlowOff(cause instanceof RequestError && cause.status === 409);
      setError(cause instanceof Error ? cause.message : "Could not start GitHub sign-in.");
    } finally {
      setPending(false);
    }
  }

  function cancel() {
    attempt.current += 1;
    setStatus(null);
    setError("");
    setPaused(false);
  }

  const awaiting = status?.state === "awaiting_code" ? status : null;

  useEffect(() => {
    if (!awaiting || paused) return;

    const id = attempt.current;
    const delay = Math.min(30, Math.max(1, awaiting.pollAfterSeconds)) * 1000;

    const timer = setTimeout(() => {
      githubSignIn().then(
        (next) => apply(next, id),
        (cause) => {
          if (id !== attempt.current) return;

          failures.current += 1;

          // A refused account or a cancelled approval ends this attempt; anything else is retried.
          if (cause instanceof RequestError && cause.status === 403) {
            setStatus(null);
            setError(cause.message);
          } else if (failures.current >= maxPollFailures) {
            setPaused(true);
            setError(cause instanceof Error ? cause.message : "Could not check GitHub sign-in.");
          } else setStatus({ ...awaiting });
        },
      );
    }, delay);

    return () => clearTimeout(timer);
  }, [awaiting, paused]);

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
            Open GitHub
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
              Waiting for GitHub. Authorize there, then come back here.
            </span>
          )}
          <button type="button" className="ghost-button" onClick={cancel}>
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
      {status?.state === "expired" ? (
        <p className="muted">That code expired before it was authorized.</p>
      ) : firstRun ? (
        <p className="muted">
          Your GitHub App is ready. Tick <strong>Enable Device Flow</strong> in{" "}
          <a href={settingsUrl} target="_blank" rel="noreferrer">
            its settings
          </a>
          , then sign in. The first account to sign in owns this dolly.
        </p>
      ) : (
        <p className="muted">Sign in with the GitHub account that owns this dolly.</p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
          {deviceFlowOff && (
            <>
              {" "}
              <a href={settingsUrl} target="_blank" rel="noreferrer">
                Open the app's settings
              </a>
            </>
          )}
        </p>
      )}
      <button
        type="button"
        className="primary-button"
        disabled={pending}
        onClick={() => void start()}
      >
        {pending
          ? "Getting a code…"
          : status?.state === "expired"
            ? "Get a new code"
            : "Sign in with GitHub"}
      </button>
    </div>
  );
}
