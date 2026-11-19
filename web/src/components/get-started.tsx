import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowTopRightOnSquareIcon, CheckIcon } from "@heroicons/react/16/solid";
import * as Schema from "effect/Schema";
import { request } from "../lib/api";

const Onboarding = Schema.Struct({
  accounts: Schema.Array(Schema.String),
  installations: Schema.Array(
    Schema.Struct({
      login: Schema.String,
      allowed: Schema.Boolean,
      pendingApproval: Schema.Boolean,
      settingsUrl: Schema.String,
    }),
  ),
  enrolled: Schema.Number,
  missingPermissions: Schema.Array(Schema.String),
  missingEvents: Schema.Array(Schema.String),
});

export type Onboarding = typeof Onboarding.Type;

/**
 * Where GitHub setup stands. Reloads when the window regains focus, because each step is finished
 * on github.com in another tab. `null` while loading or when the server cannot say.
 */
export function useOnboarding() {
  const [state, setState] = useState<Onboarding | null>(null);

  const reload = useCallback(
    () =>
      request("/integrations/github/onboarding").then(
        (text) => setState(Schema.decodeUnknownSync(Schema.fromJsonString(Onboarding))(text)),
        () => setState(null),
      ),
    [],
  );

  useEffect(() => {
    void reload();
    window.addEventListener("focus", reload);

    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  return { state, reload };
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="secondary-button" href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowTopRightOnSquareIcon />
    </a>
  );
}

/** App settings or installation approvals that lag behind what this dolly's manifest asks for. */
export function AppHealth({
  onboarding,
  settingsUrl,
}: {
  onboarding: Onboarding;
  settingsUrl: string;
}) {
  const outdated = onboarding.missingPermissions.length + onboarding.missingEvents.length > 0;
  const approvals = onboarding.installations.filter((installation) => installation.pendingApproval);

  if (!outdated && approvals.length === 0) return null;

  return (
    <div className="app-health" role="status">
      {outdated && (
        <div className="app-health-row">
          <p>
            Your GitHub App predates settings dolly now uses.{" "}
            {onboarding.missingPermissions.length > 0 && (
              <>
                Set permissions <code>{onboarding.missingPermissions.join(", ")}</code>.{" "}
              </>
            )}
            {onboarding.missingEvents.length > 0 && (
              <>
                Subscribe to <code>{onboarding.missingEvents.join(", ")}</code> events, so CI waits
                wake as soon as checks finish.
              </>
            )}
          </p>
          <External href={settingsUrl}>App settings</External>
        </div>
      )}
      {approvals.map((installation) => (
        <div className="app-health-row" key={installation.login}>
          <p>
            <strong>{installation.login}</strong> has not approved the App's updated permissions.
          </p>
          <External href={installation.settingsUrl}>Review</External>
        </div>
      ))}
    </div>
  );
}

type Step = { title: string; done: boolean; detail: ReactNode; action: ReactNode };

/**
 * First-run checklist in place of the empty workspace. Each step can be finished from here, and
 * `fallback` takes over once everything is done or when setup state is unavailable.
 */
export function GetStarted({
  modelConnected,
  installUrl,
  settingsUrl,
  onConnectModel,
  onNewSession,
  fallback,
}: {
  modelConnected: boolean;
  installUrl: string;
  settingsUrl: string;
  onConnectModel: () => void;
  onNewSession: () => void;
  fallback: ReactNode;
}) {
  const { state, reload } = useOnboarding();
  const [allowing, setAllowing] = useState("");
  const [error, setError] = useState("");

  if (!state) return fallback;

  const installed = state.installations.length > 0;
  const allowed = state.installations.some((installation) => installation.allowed);
  const waiting = state.installations.filter((installation) => !installation.allowed);

  async function allow(login: string) {
    if (!state) return;

    setAllowing(login);
    setError("");

    try {
      await request(
        "/integrations/github/accounts",
        { accounts: [...state.accounts, login] },
        undefined,
        "PUT",
      );
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not allow ${login}.`);
    } finally {
      setAllowing("");
    }
  }

  const steps: Step[] = [
    {
      title: "Connect a model",
      done: modelConnected,
      detail: "A ChatGPT subscription or a Claude setup token runs the agents.",
      action: (
        <button type="button" className="secondary-button" onClick={onConnectModel}>
          Connect
        </button>
      ),
    },
    {
      title: "Install the GitHub App",
      done: installed,
      detail: installed
        ? `Installed on ${state.installations.map((installation) => installation.login).join(", ")}.`
        : "Choose the accounts and repositories dolly may open. Come back here when GitHub is done.",
      action: <External href={installUrl}>Install</External>,
    },
    {
      title: "Allow accounts",
      done: allowed,
      detail: allowed
        ? `Agents may work in ${state.accounts.join(", ")}.`
        : "Installing grants GitHub access; allowing an account lets agents use it.",
      action: waiting.map((installation) => (
        <button
          key={installation.login}
          type="button"
          className="secondary-button"
          disabled={!!allowing}
          onClick={() => void allow(installation.login)}
        >
          {allowing === installation.login ? "Allowing…" : `Allow ${installation.login}`}
        </button>
      )),
    },
    {
      title: "Enroll repositories",
      done: state.enrolled > 0,
      detail:
        state.enrolled > 0
          ? `${state.enrolled} ${state.enrolled === 1 ? "repository" : "repositories"} ready for sessions.`
          : "Pick which installed repositories appear when you start a session.",
      action: (
        <Link className="secondary-button" to="/settings/repositories">
          Choose
        </Link>
      ),
    },
  ];

  if (steps.every((step) => step.done)) return fallback;

  const current = steps.findIndex((step) => !step.done);

  return (
    <section className="get-started" aria-labelledby="get-started-title">
      <span className="brand-mark large" aria-hidden="true">
        D
      </span>
      <h2 id="get-started-title">Get dolly ready</h2>
      <AppHealth onboarding={state} settingsUrl={settingsUrl} />
      <ol className="get-started-steps">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={step.done ? "done" : index === current ? "current" : ""}
            aria-current={index === current ? "step" : undefined}
          >
            <span className="get-started-marker" aria-hidden="true">
              {step.done ? <CheckIcon /> : index + 1}
            </span>
            <div className="get-started-text">
              <strong>
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
              </strong>
              <span className="muted">{step.detail}</span>
            </div>
            {!step.done && index === current && (
              <div className="get-started-actions">{step.action}</div>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <button
        type="button"
        className="ghost-button"
        disabled={!modelConnected}
        onClick={onNewSession}
      >
        Start a session without a repository
      </button>
    </section>
  );
}
