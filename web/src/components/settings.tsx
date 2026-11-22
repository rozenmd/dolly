import { createContext, use, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowLeftIcon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  CpuChipIcon,
  FolderIcon,
  LinkIcon,
  PuzzlePieceIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import {
  authState,
  chatgptLogin,
  defaultModel,
  request,
  type ApiBody,
  type AuthState,
  type DefaultModel,
  type DefaultModelChange,
} from "../lib/api";
import { AnthropicConnection } from "./anthropic";
import { ChatGPTLogin } from "./chatgpt-login";
import { ingressHook } from "./github";
import { AppHealth, useOnboarding } from "./get-started";
import { RepositoryPicker } from "./repositories";
import { EFFORTS, ModelPicker, SPEEDS, effortName, modelName, speedName } from "./model-select";
import { Picker } from "./picker";
import { Input, Modal } from "./ui";
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
  { to: "/settings/connections", label: "Connections", Icon: PuzzlePieceIcon },
  { to: "/settings/automations", label: "Automations", Icon: BoltIcon },
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
  const [chatgpt, setChatGPT] = useState<boolean | null>(null);
  const [claude, setClaude] = useState<boolean | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const { pending, run, alert } = useAction();

  useEffect(() => {
    chatgptLogin().then(
      (status) => setChatGPT(status.state === "connected"),
      () => setChatGPT(null),
    );
  }, []);

  return (
    <Section title="Models" description="Subscriptions agents use to run sessions.">
      <div className="connection-row">
        <span className={`status-dot ${chatgpt ? "idle" : ""}`} />
        <span className="connection-label">
          ChatGPT
          <span className="muted">{chatgpt ? "Signed in" : "Not signed in"}</span>
        </span>
        {chatgpt ? (
          <button
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={() => {
              if (!confirm("Sign out of ChatGPT? ChatGPT sessions will need you to sign in again."))
                return;

              void run(async () => {
                await chatgptLogin("DELETE");
                setChatGPT(false);
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
      {signingIn && !chatgpt && (
        <ChatGPTLogin
          onConnected={() => {
            setChatGPT(true);
            setSigningIn(false);
          }}
          onCancel={() => setSigningIn(false)}
        />
      )}
      <AnthropicConnection variant="row" onConnection={setClaude} />
      {alert}
      <DefaultModelSetting key={`${String(chatgpt)}:${String(claude)}`} />
      <UsageLimits key={String(chatgpt)} />
    </Section>
  );
}

/** Saved on the server, so it applies to sessions from the web app, the API and Slack. */
function DefaultModelSetting() {
  const [setting, setSetting] = useState<DefaultModel | null>(null);
  const { pending, run, alert } = useAction();

  useEffect(() => {
    let active = true;
    defaultModel().then(
      (value) => {
        if (active) setSetting(value);
      },
      () => {},
    );

    return () => {
      active = false;
    };
  }, []);

  const unavailable = setting?.model != null && setting.model !== setting.effective;

  const save = (change: DefaultModelChange, failure: string) =>
    void run(async () => {
      setSetting(await defaultModel(change));
    }, failure);

  return (
    <>
      <div className="connection-row">
        <span className="connection-label">
          Default model
          <span className="muted">
            {setting
              ? unavailable
                ? `Using ${modelName(setting.effective)} until that subscription is connected`
                : `New sessions use ${modelName(setting.effective)} unless you pick another`
              : "Loading…"}
          </span>
        </span>
        <ModelPicker
          id="default-model"
          value={setting?.model ?? ""}
          defaultLabel="Automatic"
          disabled={!setting || pending}
          onChange={(model) => save({ model: model || null }, "Could not save the default model.")}
        />
      </div>
      <div className="connection-row">
        <span className="connection-label">
          GitHub review model
          <span className="muted">
            {setting
              ? setting.reviewModel != null && setting.reviewModel !== setting.reviewEffective
                ? `Using ${modelName(setting.reviewEffective)} until that subscription is connected`
                : `Automatic pull request reviews use ${modelName(setting.reviewEffective)}`
              : "Loading…"}
          </span>
        </span>
        <ModelPicker
          id="review-model"
          value={setting?.reviewModel ?? ""}
          defaultLabel="Same as default"
          disabled={!setting || pending}
          onChange={(model) =>
            save({ reviewModel: model || null }, "Could not save the GitHub review model.")
          }
        />
      </div>
      <div className="connection-row">
        <span className="connection-label">
          Default effort
          <span className="muted">How long new sessions think before answering</span>
        </span>
        <Picker
          id="default-effort"
          label="Default effort"
          className="model-picker"
          align="end"
          value={setting?.thinkingLevel ?? ""}
          options={EFFORTS.filter((option) => option.value !== "minimal")}
          disabled={!setting || pending}
          onChange={(thinkingLevel) =>
            save({ thinkingLevel }, "Could not save the default effort.")
          }
          trigger={<span>{setting ? effortName(setting.thinkingLevel) : "…"}</span>}
        />
      </div>
      <div className="connection-row">
        <span className="connection-label">
          Default speed
          <span className="muted">
            Faster ChatGPT service tiers; Claude models always run at standard speed
          </span>
        </span>
        <Picker
          id="default-speed"
          label="Default speed"
          className="model-picker"
          align="end"
          value={setting?.speed ?? ""}
          options={SPEEDS.filter(
            (value) => value !== "ultrafast" || setting?.ultrafastAvailable,
          ).map((value) => ({ value, label: speedName(value) }))}
          disabled={!setting || pending}
          onChange={(value) => {
            const speed = SPEEDS.find((option) => option === value);

            if (speed) save({ speed }, "Could not save the speed.");
          }}
          trigger={<span>{setting ? speedName(setting.speed) : "…"}</span>}
        />
      </div>
      <label className="connection-row">
        <span className="connection-label">
          Auto-fallback
          <span className="muted">
            Switch to the other subscription when a session runs out of usage
          </span>
        </span>
        <input
          id="default-auto-fallback"
          type="checkbox"
          className="switch"
          checked={setting?.autoFallback ?? true}
          disabled={!setting || pending}
          onChange={(event) =>
            save({ autoFallback: event.target.checked }, "Could not save auto-fallback.")
          }
        />
      </label>
      {alert}
    </>
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
  const [reviews, setReviews] = useState(github.reviews);
  const [saved, setSaved] = useState("");
  const { pending, run, alert } = useAction();
  const onboarding = useOnboarding();

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

      // Saved whenever it changed, including to empty, which stops every /dolly command.
      if (next.join(",") !== github.senders.join(",") || reviews !== github.reviews) {
        await request("/integrations/github/webhook", { senders: next, reviews }, undefined, "PUT");
        update({ ...github, senders: next, reviews });
      }

      setSaved("access");
    }, "Could not save GitHub access.");
  }

  return (
    <Section title="GitHub" description="How GitHub reaches dolly, and who can use it.">
      {onboarding.state && (
        <AppHealth onboarding={onboarding.state} settingsUrl={github.settingsUrl} />
      )}
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
            : "Where GitHub sends comments and CI updates."}
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
        <label htmlFor="settings-senders">Who can run /dolly commands</label>
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
            : "GitHub users whose /dolly comments on pull requests start an agent."}
        </p>
        <label className="connection-row">
          <span className="connection-label">
            Review new pull requests
            <span className="muted">
              When one of these users or a dolly session opens a pull request in an enrolled
              repository, marks a draft ready or pushes to it, dolly reviews it with inline
              comments. Findings on a pull request a dolly session opened go back to that session to
              fix, for up to 6 rounds. Each review uses your model subscription; choose its model
              under Models.
            </span>
          </span>
          <input
            id="settings-reviews"
            name="reviews"
            type="checkbox"
            className="switch"
            checked={reviews}
            onChange={(event) => {
              setReviews(event.target.checked);
              setSaved("");
            }}
          />
        </label>
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

const SlackMember = Schema.Struct({
  slackId: Schema.String,
  github: Schema.NullOr(Schema.String),
});

type SlackMember = typeof SlackMember.Type;

const SlackStatus = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  members: Schema.Array(SlackMember),
  defaultRepository: Schema.NullOr(Schema.String),
  teamName: Schema.NullOr(Schema.String),
  eventsUrl: Schema.NullOr(Schema.String),
  actionsUrl: Schema.NullOr(Schema.String),
  createAppUrl: Schema.NullOr(Schema.String),
  manifest: Schema.NullOr(Schema.String),
});

type SlackStatus = typeof SlackStatus.Type;

const loadSlack = async () =>
  Schema.decodeUnknownSync(Schema.fromJsonString(SlackStatus))(
    await request("/integrations/slack"),
  );

/**
 * Slack setup in the order Slack hands things out: create the app from Dolly's manifest,
 * install it, then copy the two credentials Slack generates into Dolly.
 */
export function SlackSettings() {
  const { github, update } = useSettings();
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [ingress, setIngress] = useState(github.ingress ?? "");
  const [enabled, setEnabled] = useState(true);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [defaultRepository, setDefaultRepository] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const { pending, run, alert } = useAction();

  function load(next: SlackStatus) {
    setStatus(next);
    setEnabled(next.configured ? next.enabled : true);
    setDefaultRepository(next.defaultRepository ?? "");
  }

  useEffect(() => {
    loadSlack().then(load, (cause) =>
      setLoadError(cause instanceof Error ? cause.message : "Could not load Slack settings."),
    );
  }, []);

  function saveIngress(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ ingress: Schema.String })),
      )(
        await request(
          "/integrations/github/ingress",
          { url: ingressHook(ingress) },
          undefined,
          "PUT",
        ),
      );

      update({ ...github, ingress: result.ingress });
      load(await loadSlack());
    }, "Could not save the ingress URL.");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    void run(async () => {
      const body: ApiBody = {
        enabled,
        defaultRepository: defaultRepository.trim(),
      };

      // Empty secret fields keep the saved values.
      if (botToken.trim()) body.botToken = botToken.trim();

      if (signingSecret.trim()) body.signingSecret = signingSecret.trim();

      await request("/integrations/slack", body, undefined, "PUT");
      setBotToken("");
      setSigningSecret("");
      load(await loadSlack());
      setSaved(true);
    }, "Could not save Slack settings.");
  }

  const connected = status?.configured ?? false;

  return (
    <Section
      title="Slack"
      description="DM dolly or @-mention it in a channel to start or continue a session in that thread."
    >
      {loadError && (
        <p role="alert" className="error-text">
          {loadError}
        </p>
      )}
      {connected && status && (
        <div className="connection-row">
          <span className={`status-dot ${status.enabled ? "idle" : ""}`} />
          <span className="connection-label">
            Slack
            <span className="muted">
              {status.enabled ? "Connected" : "Disabled"} to {status.teamName ?? "your workspace"}
            </span>
          </span>
        </div>
      )}

      <section className="settings-card" aria-labelledby="slack-step-create">
        <h2 id="slack-step-create" className="settings-step">
          1. Create the Slack app
        </h2>
        {status?.createAppUrl ? (
          <>
            <p className="field-help">
              Slack opens with everything filled in: permissions, events and the URLs dolly listens
              on. Pick your workspace, choose <strong>Next</strong>, then <strong>Create</strong>.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void navigator.clipboard.writeText(status.manifest ?? "").then(() => {
                    setCopied(true);
                  });
                }}
              >
                {copied ? "Copied" : "Copy manifest"}
              </button>
              <a
                className="primary-button"
                href={status.createAppUrl}
                target="_blank"
                rel="noreferrer"
              >
                Create Slack app
              </a>
            </div>
          </>
        ) : status ? (
          <form className="settings-inline-form" onSubmit={saveIngress}>
            <p className="field-help">
              Slack needs dolly's public ingress URL first: the <code>dolly-ingress</code> Worker
              that also receives GitHub webhooks.
            </p>
            <label htmlFor="slack-ingress">Ingress URL</label>
            <Input
              id="slack-ingress"
              type="url"
              required
              placeholder="https://dolly-ingress.example.workers.dev"
              value={ingress}
              onChange={(event) => setIngress(event.target.value)}
            />
            <div className="modal-actions">
              <button type="submit" className="primary-button" disabled={pending}>
                Continue
              </button>
            </div>
          </form>
        ) : (
          !loadError && <p className="field-help">Loading…</p>
        )}
      </section>

      <form className="settings-card" onSubmit={save} aria-labelledby="slack-step-connect">
        <h2 id="slack-step-connect" className="settings-step">
          2. Install it and connect dolly
        </h2>
        <p className="field-help">
          Slack generates these two values once the app exists. Paste them here.
        </p>
        <label htmlFor="slack-bot-token">Bot token</label>
        <Input
          id="slack-bot-token"
          name="botToken"
          type="password"
          autoComplete="off"
          placeholder={connected ? "Saved — paste to replace" : "xoxb-…"}
          value={botToken}
          onChange={(event) => setBotToken(event.target.value)}
          required={!connected}
        />
        <p className="field-help">
          In your new app, open <strong>Install App</strong> and choose{" "}
          <strong>Install to Workspace</strong>, then copy the <strong>Bot User OAuth Token</strong>
          .
        </p>
        <label htmlFor="slack-signing-secret">Signing secret</label>
        <Input
          id="slack-signing-secret"
          name="signingSecret"
          type="password"
          autoComplete="off"
          placeholder={connected ? "Saved — paste to replace" : ""}
          value={signingSecret}
          onChange={(event) => setSigningSecret(event.target.value)}
          required={!connected}
        />
        <p className="field-help">
          <strong>Basic Information</strong> → <strong>App Credentials</strong> →{" "}
          <strong>Signing Secret</strong> (choose Show).
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
          An enrolled repository for DMs, and for mentions dolly cannot match to a repository.
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable Slack
        </label>
        <div className="modal-actions">
          {connected && (
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
                  load(await loadSlack());
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
        {saved && <p className="field-help">Saved.</p>}
      </form>

      <section className="settings-card" aria-labelledby="slack-step-verify">
        <h2 id="slack-step-verify" className="settings-step">
          3. Finish in Slack
        </h2>
        <p className="field-help">
          Slack checks the events URL before dolly has the signing secret, so the first check fails.
          After saving, open <strong>Event Subscriptions</strong> in your app and choose{" "}
          <strong>Retry</strong>
          {status?.eventsUrl ? (
            <>
              {" "}
              next to <code>{status.eventsUrl}</code>
            </>
          ) : null}
          . Then invite the bot to channels it should read and send it a DM.
        </p>
      </section>
      {connected && status && (
        <SlackTeammates
          members={status.members}
          senders={github.senders}
          onSaved={(members) => setStatus({ ...status, members })}
        />
      )}
      {alert}
    </Section>
  );
}

/** One row per person: everyone approved for /dolly commands, plus anyone given a Slack ID here. */
function teammateRows(members: readonly SlackMember[], senders: readonly string[]) {
  const rows: { github: string | null; slackId: string | null }[] = members.map((member) => ({
    ...member,
  }));

  for (const login of senders)
    if (!rows.some((row) => row.github?.toLowerCase() === login.toLowerCase()))
      rows.push({ github: login, slackId: null });

  return rows.sort((a, b) =>
    (a.github ?? a.slackId ?? "").localeCompare(b.github ?? b.slackId ?? ""),
  );
}

type TeammateDraft = {
  github: string;
  slackId: string;
  original: SlackMember | null;
  /** Fixed when the dialog opens, so typing a login does not rename it. */
  title: string;
};

/**
 * Who may start sessions from Slack. Slack only proves a sender's member ID, so each person is a
 * GitHub login with the Slack member ID that stands for them.
 */
function SlackTeammates({
  members,
  senders,
  onSaved,
}: {
  members: readonly SlackMember[];
  senders: readonly string[];
  onSaved: (members: readonly SlackMember[]) => void;
}) {
  const [draft, setDraft] = useState<TeammateDraft | null>(null);
  const { pending, run, alert } = useAction();
  const rows = teammateRows(members, senders);

  async function save(next: readonly SlackMember[]) {
    const result = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ members: Schema.Array(SlackMember) })),
    )(await request("/integrations/slack/members", { members: next }, undefined, "PUT"));

    onSaved(result.members);
  }

  function submit(event: FormEvent) {
    event.preventDefault();

    if (!draft) return;
    const login = draft.github.trim().replace(/^@/, "");
    const slackId = draft.slackId.trim().toUpperCase();

    void run(async () => {
      const rest = members.filter(
        (member) =>
          member !== draft.original &&
          member.slackId !== slackId &&
          (!login || member.github?.toLowerCase() !== login.toLowerCase()),
      );

      await save([...rest, { slackId, github: login || null }]);
      setDraft(null);
    }, "Could not save the teammate.");
  }

  function remove(member: SlackMember) {
    void run(
      () => save(members.filter((other) => other !== member)),
      "Could not remove the teammate.",
    );
  }

  return (
    <section className="settings-card" aria-labelledby="slack-teammates">
      <div className="teammates-header">
        <h2 id="slack-teammates" className="settings-step">
          Teammates
        </h2>
        <button
          type="button"
          className="secondary-button"
          disabled={pending}
          onClick={() =>
            setDraft({ github: "", slackId: "", original: null, title: "Add teammate" })
          }
        >
          Add teammate
        </button>
      </div>
      {rows.length ? (
        <ul className="teammate-list">
          {rows.map((row) => {
            const member = members.find(
              (candidate) => candidate.slackId === row.slackId && candidate.github === row.github,
            );

            return (
              <li key={row.github ?? row.slackId} className="teammate-row">
                <span className="connection-label">
                  {row.github ? `@${row.github}` : "No GitHub login"}
                  <span className="muted">
                    {row.slackId ? `Slack ${row.slackId}` : "No Slack member ID"}
                  </span>
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending}
                  onClick={() =>
                    setDraft({
                      github: row.github ?? "",
                      slackId: row.slackId ?? "",
                      original: member ?? null,
                      title: row.github ? `Slack ID for @${row.github}` : "Edit teammate",
                    })
                  }
                  aria-label={`Edit ${row.github ?? row.slackId}`}
                >
                  {row.slackId ? "Edit" : "Add Slack ID"}
                </button>
                {member && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => remove(member)}
                    aria-label={`Remove ${row.github ?? row.slackId} from Slack`}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="field-help">No teammates yet.</p>
      )}
      <p className="field-help">
        {members.length
          ? "Only teammates with a Slack member ID can start sessions from Slack, and sessions name who asked. Anyone in your workspace can reply in a thread that already has a session."
          : "Anyone in your workspace can start sessions. Add a Slack member ID to a teammate to limit it to them."}{" "}
        People who can run /dolly commands appear here automatically.
      </p>
      {alert}
      {draft && (
        <Modal title={draft.title} onClose={() => setDraft(null)}>
          <form onSubmit={submit}>
            <label htmlFor="teammate-github">GitHub login</label>
            <Input
              id="teammate-github"
              required
              autoCapitalize="none"
              spellCheck={false}
              placeholder="octocat"
              value={draft.github}
              onChange={(event) => setDraft({ ...draft, github: event.target.value })}
            />
            <label htmlFor="teammate-slack">Slack member ID</label>
            <Input
              id="teammate-slack"
              required
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="U012ABCDEF"
              value={draft.slackId}
              onChange={(event) => setDraft({ ...draft, slackId: event.target.value })}
            />
            <p className="field-help">
              In Slack, open their profile, choose <strong>⋮</strong> then{" "}
              <strong>Copy member ID</strong>.
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={pending}>
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
