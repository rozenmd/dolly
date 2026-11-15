import { createContext, use, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowLeftIcon,
  ChatBubbleLeftRightIcon,
  CpuChipIcon,
  FolderIcon,
  LinkIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { authState, codexLogin, request, type ApiBody, type AuthState } from "../lib/api";
import { AnthropicConnection } from "./anthropic";
import { CodexLogin } from "./codex-login";
import { ingressHook } from "./github";
import { RepositoryPicker } from "./repositories";
import { Input } from "./ui";
import { UsageLimits } from "./usage";

type Connected = Extract<AuthState["github"], { connected: true }>;

type Settings = {
  login: string;
  github: Connected;
  update: (github: Connected) => void;
  signOut: () => void;
};

const SettingsContext = createContext<Settings | null>(null);

function useSettings() {
  const settings = use(SettingsContext);

  if (!settings) throw new Error("Settings sections render inside SettingsLayout.");

  return settings;
}

const sections = [
  { to: "/settings/account", label: "Account", Icon: UserIcon },
  { to: "/settings/models", label: "Models", Icon: CpuChipIcon },
  { to: "/settings/repositories", label: "Repositories", Icon: FolderIcon },
  { to: "/settings/github", label: "GitHub", Icon: LinkIcon },
  { to: "/settings/slack", label: "Slack", Icon: ChatBubbleLeftRightIcon },
] as const;

/** Full-page settings with its own navigation; each section has its own URL. */
export function SettingsLayout() {
  const navigate = useNavigate();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    authState().then(
      (state) => {
        // Settings needs a signed-in user with the GitHub App set up; the workspace handles both.
        if (!state.user || !state.github.connected) void navigate({ to: "/", replace: true });
        else setAuth(state);
      },
      (cause) => setError(cause instanceof Error ? cause.message : "Could not reach dolly."),
    );
  }, [navigate]);

  const user = auth?.user;
  const github = auth?.github.connected ? auth.github : null;

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="Settings">
        <Link to="/" className="nav-row">
          <ArrowLeftIcon width={16} />
          Back to app
        </Link>
        <h2 className="settings-nav-heading">Settings</h2>
        {sections.map(({ to, label, Icon }) => (
          <Link key={to} to={to} className="nav-row" activeProps={{ className: "active" }}>
            <Icon width={16} />
            {label}
          </Link>
        ))}
      </nav>
      <main id="main-content" className="settings-main">
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {user && github && (
          <SettingsContext
            value={{
              login: user.login,
              github,
              update: (next) => setAuth({ ...auth, github: next }),
              signOut: () => void navigate({ to: "/" }),
            }}
          >
            <Outlet />
          </SettingsContext>
        )}
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <h1>{title}</h1>
      <p className="settings-description">{description}</p>
      {children}
    </section>
  );
}

function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<void>, failure: string) {
    setPending(true);
    setError("");

    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : failure);
    } finally {
      setPending(false);
    }
  }

  const alert = error ? (
    <p role="alert" className="error-text">
      {error}
    </p>
  ) : null;

  return { pending, run, alert };
}

export function AccountSettings() {
  const { login, signOut } = useSettings();
  const { pending, run, alert } = useAction();

  return (
    <Section title="Account" description="Who you are signed in to dolly as.">
      <div className="connection-row">
        <span className="status-dot idle" />
        <span className="connection-label">
          GitHub
          <span className="muted">Signed in as @{login}</span>
        </span>
        <button
          type="button"
          className="secondary-button"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              await request("/auth/session", undefined, undefined, "DELETE");
              signOut();
            }, "Could not sign out.")
          }
        >
          Sign out
        </button>
      </div>
      {alert}
    </Section>
  );
}

export function ModelsSettings() {
  const [codex, setCodex] = useState<boolean | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const { pending, run, alert } = useAction();

  useEffect(() => {
    codexLogin().then(
      (status) => setCodex(status.state === "connected"),
      () => setCodex(null),
    );
  }, []);

  return (
    <Section title="Models" description="Subscriptions agents use to run sessions.">
      <div className="connection-row">
        <span className={`status-dot ${codex ? "idle" : ""}`} />
        <span className="connection-label">
          ChatGPT
          <span className="muted">{codex ? "Signed in" : "Not signed in"}</span>
        </span>
        {codex ? (
          <button
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={() => {
              if (!confirm("Sign out of ChatGPT? Codex sessions will need you to sign in again."))
                return;

              void run(async () => {
                await codexLogin("DELETE");
                setCodex(false);
              }, "Could not sign out of ChatGPT.");
            }}
          >
            Sign out
          </button>
        ) : (
          !signingIn && (
            <button type="button" className="primary-button" onClick={() => setSigningIn(true)}>
              Sign in
            </button>
          )
        )}
      </div>
      {signingIn && !codex && (
        <CodexLogin
          onConnected={() => {
            setCodex(true);
            setSigningIn(false);
          }}
          onCancel={() => setSigningIn(false)}
        />
      )}
      <AnthropicConnection variant="row" onConnection={() => {}} />
      {alert}
      <UsageLimits key={String(codex)} />
    </Section>
  );
}

export function RepositoriesSettings() {
  const { github } = useSettings();

  return (
    <Section title="Repositories" description="Repositories agents can check out and work in.">
      <div className="connection-row">
        <span className="status-dot idle" />
        <span className="connection-label">
          GitHub App
          <span className="muted">{github.appSlug}</span>
        </span>
        <a className="secondary-button" href={github.installUrl} target="_blank" rel="noreferrer">
          Add repositories
        </a>
      </div>
      <RepositoryPicker manage />
    </Section>
  );
}

/** Logins from a comma- or space-separated list, without a leading @. */
function logins(value: string) {
  return value
    .split(/[\s,]+/)
    .map((login) => login.replace(/^@/, ""))
    .filter(Boolean);
}

export function GitHubSettings() {
  const { login, github, update } = useSettings();
  const [ingress, setIngress] = useState(github.ingress ?? "");
  const [accounts, setAccounts] = useState("");
  const [senders, setSenders] = useState(github.senders.join(", "));
  const [saved, setSaved] = useState("");
  const { pending, run, alert } = useAction();

  useEffect(() => {
    let active = true;

    void run(async () => {
      const result = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ accounts: Schema.Array(Schema.String) })),
      )(await request("/integrations/github/accounts"));

      if (active) setAccounts(result.accounts.join(", "));
    }, "Could not load allowed accounts.");

    return () => {
      active = false;
    };
  }, []);

  function saveIngress(event: FormEvent) {
    event.preventDefault();
    setSaved("");
    void run(async () => {
      const text = await request(
        "/integrations/github/ingress",
        { url: ingressHook(ingress) },
        undefined,
        "PUT",
      );

      const result = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ ingress: Schema.String })),
      )(text);

      setIngress(result.ingress);
      update({ ...github, ingress: result.ingress });
      setSaved("ingress");
    }, "Could not update the ingress URL.");
  }

  function saveAccess(event: FormEvent) {
    event.preventDefault();
    setSaved("");
    void run(async () => {
      await request(
        "/integrations/github/accounts",
        { accounts: logins(accounts) },
        undefined,
        "PUT",
      );

      const next = logins(senders);

      // Saved whenever it changed, including to empty, which stops every /pi command.
      if (next.join(",") !== github.senders.join(",")) {
        await request("/integrations/github/webhook", { senders: next }, undefined, "PUT");
        update({ ...github, senders: next });
      }

      setSaved("access");
    }, "Could not save GitHub access.");
  }

  return (
    <Section title="GitHub" description="How GitHub reaches dolly, and who can use it.">
      <form className="settings-card" onSubmit={saveIngress}>
        <label htmlFor="settings-ingress">Ingress URL</label>
        <Input
          id="settings-ingress"
          name="ingress"
          type="url"
          required
          value={ingress}
          onChange={(event) => {
            setIngress(event.target.value);
            setSaved("");
          }}
          aria-describedby="settings-ingress-help"
        />
        <p id="settings-ingress-help" className="field-help">
          {saved === "ingress"
            ? "Saved. GitHub now sends comments to this URL."
            : "Where GitHub sends issue and pull request comments."}
        </p>
        <div className="modal-actions">
          <button type="submit" className="primary-button" disabled={pending}>
            Save
          </button>
        </div>
      </form>
      <form className="settings-card" onSubmit={saveAccess}>
        <label htmlFor="settings-accounts">Accounts dolly can work in</label>
        <Input
          id="settings-accounts"
          name="accounts"
          placeholder={`e.g. ${github.owner}`}
          value={accounts}
          onChange={(event) => {
            setAccounts(event.target.value);
            setSaved("");
          }}
          aria-describedby="settings-accounts-help"
        />
        <p id="settings-accounts-help" className="field-help">
          {accounts.trim()
            ? "GitHub users and organizations whose repositories agents may use, separated by commas."
            : "No GitHub accounts are allowed. Add the repository owner and Save. Installing the App does not populate this list."}
        </p>
        <label htmlFor="settings-senders">Who can run /pi commands</label>
        <Input
          id="settings-senders"
          name="senders"
          placeholder={login}
          value={senders}
          onChange={(event) => {
            setSenders(event.target.value);
            setSaved("");
          }}
          aria-describedby="settings-senders-help"
        />
        <p id="settings-senders-help" className="field-help">
          {saved === "access"
            ? "Saved."
            : "GitHub users whose /pi comments on pull requests start an agent."}
        </p>
        <div className="modal-actions">
          <button type="submit" className="primary-button" disabled={pending}>
            Save
          </button>
        </div>
      </form>
      {alert}
    </Section>
  );
}

const SlackStatus = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  allowedUserId: Schema.NullOr(Schema.String),
  defaultRepository: Schema.NullOr(Schema.String),
  teamName: Schema.NullOr(Schema.String),
  eventsUrl: Schema.NullOr(Schema.String),
  actionsUrl: Schema.NullOr(Schema.String),
  createAppUrl: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.Struct({ label: Schema.String, items: Schema.Array(Schema.String) })),
  events: Schema.Array(Schema.String),
});

type SlackStatus = typeof SlackStatus.Type;

/** Slack setup: create the app from a manifest, then paste the two credentials. */
export function SlackSettings() {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [allowedUserId, setAllowedUserId] = useState("");
  const [defaultRepository, setDefaultRepository] = useState("");
  const [saved, setSaved] = useState(false);
  const { pending, run, alert } = useAction();

  function load(next: SlackStatus) {
    setStatus(next);
    setEnabled(next.configured ? next.enabled : true);
    setAllowedUserId(next.allowedUserId ?? "");
    setDefaultRepository(next.defaultRepository ?? "");
  }

  useEffect(() => {
    void run(async () => {
      load(
        Schema.decodeUnknownSync(Schema.fromJsonString(SlackStatus))(
          await request("/integrations/slack"),
        ),
      );
    }, "Could not load Slack settings.");
  }, []);

  function save(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    void run(async () => {
      const body: ApiBody = {
        enabled,
        allowedUserId: allowedUserId.trim(),
        defaultRepository: defaultRepository.trim(),
      };

      // Empty secret fields keep the saved values.
      if (botToken.trim()) body.botToken = botToken.trim();

      if (signingSecret.trim()) body.signingSecret = signingSecret.trim();

      await request("/integrations/slack", body, undefined, "PUT");
      setBotToken("");
      setSigningSecret("");
      load(
        Schema.decodeUnknownSync(Schema.fromJsonString(SlackStatus))(
          await request("/integrations/slack"),
        ),
      );
      setSaved(true);
    }, "Could not save Slack settings.");
  }

  return (
    <Section
      title="Slack"
      description="DMs and @-mentions start or continue dolly sessions in a Slack thread."
    >
      <div className="connection-row">
        <span className={`status-dot ${status?.configured && status.enabled ? "idle" : ""}`} />
        <span className="connection-label">
          Slack app
          <span className="muted">
            {status?.configured
              ? `${status.enabled ? "Enabled" : "Disabled"} in ${status.teamName ?? "your workspace"}`
              : "Not connected"}
          </span>
        </span>
        {status?.createAppUrl ? (
          <a
            className="secondary-button"
            href={status.createAppUrl}
            target="_blank"
            rel="noreferrer"
          >
            Create Slack app
          </a>
        ) : null}
      </div>
      {status && !status.createAppUrl && (
        <p className="field-help settings-note">
          Save the ingress URL under GitHub first; Slack sends events to the same ingress Worker.
        </p>
      )}
      {status?.eventsUrl && (
        <p className="field-help settings-note">
          Slack sends events to {status.eventsUrl} and actions to {status.actionsUrl}. Create the
          app from the manifest, install it to your workspace, then paste its credentials below.
          Invite the bot to channels whose history it should read.
        </p>
      )}
      <form className="settings-card" onSubmit={save}>
        <label htmlFor="slack-bot-token">Bot token</label>
        <Input
          id="slack-bot-token"
          name="botToken"
          type="password"
          autoComplete="off"
          placeholder={status?.configured ? "Saved — paste to replace" : "xoxb-…"}
          value={botToken}
          onChange={(event) => setBotToken(event.target.value)}
          required={!status?.configured}
        />
        <p className="field-help">From OAuth &amp; Permissions after installing the app.</p>
        <label htmlFor="slack-signing-secret">Signing secret</label>
        <Input
          id="slack-signing-secret"
          name="signingSecret"
          type="password"
          autoComplete="off"
          placeholder={status?.configured ? "Saved — paste to replace" : ""}
          value={signingSecret}
          onChange={(event) => setSigningSecret(event.target.value)}
          required={!status?.configured}
        />
        <p className="field-help">
          From Basic Information. Every Slack request must be signed with it.
        </p>
        <label htmlFor="slack-allowed-user">Allowed Slack member ID</label>
        <Input
          id="slack-allowed-user"
          name="allowedUserId"
          placeholder="U012ABCDEF"
          value={allowedUserId}
          onChange={(event) => setAllowedUserId(event.target.value)}
        />
        <p className="field-help">
          Only this member's DMs and mentions start sessions. Anyone in your workspace can reply in
          a thread already linked to a session. Leave empty to admit every member of your workspace.
        </p>
        <label htmlFor="slack-default-repository">Default repository</label>
        <Input
          id="slack-default-repository"
          name="defaultRepository"
          placeholder="owner/repo"
          value={defaultRepository}
          onChange={(event) => setDefaultRepository(event.target.value)}
        />
        <p className="field-help">
          Enrolled repository for DMs and for mentions the router cannot place. Empty starts
          sessions with no repository.
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable Slack
        </label>
        {saved && <p className="field-help">Saved.</p>}
        <div className="modal-actions">
          {status?.configured && (
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={() => {
                if (
                  !confirm(
                    "Disconnect Slack? Slack requests will be rejected until you set it up again.",
                  )
                )
                  return;

                void run(async () => {
                  await request("/integrations/slack", undefined, undefined, "DELETE");
                  load(
                    Schema.decodeUnknownSync(Schema.fromJsonString(SlackStatus))(
                      await request("/integrations/slack"),
                    ),
                  );
                }, "Could not disconnect Slack.");
              }}
            >
              Disconnect
            </button>
          )}
          <button type="submit" className="primary-button" disabled={pending}>
            Save
          </button>
        </div>
      </form>
      {status && (
        <details className="settings-card">
          <summary>Bot scopes and events</summary>
          {status.scopes.map((group) => (
            <p key={group.label} className="field-help">
              <strong>{group.label}:</strong> {group.items.join(", ")}
            </p>
          ))}
          <p className="field-help">
            <strong>Events:</strong> {status.events.join(", ")}
          </p>
        </details>
      )}
      {alert}
    </Section>
  );
}
