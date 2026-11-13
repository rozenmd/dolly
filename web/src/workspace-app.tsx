import { useEffect, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import { Bars3Icon, CheckIcon, ChevronRightIcon, LinkIcon } from "@heroicons/react/16/solid";
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  DocumentDuplicateIcon,
  ListBulletIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { Sidebar } from "./components/sidebar";
import { Composer, Conversation } from "./components/conversation";
import { IconButton, Input, Modal, RepoBadge } from "./components/ui";
import { CodexLogin } from "./components/codex-login";
import { GitHubSetup, GitHubSignIn, ingressHook } from "./components/github";
import { RepositoryPicker } from "./components/repositories";
import { NewSessionComposer } from "./components/new-session";
import { AnthropicConnection } from "./components/anthropic";
import {
  authState,
  codexLogin,
  type AuthState,
  liveFromSnapshot,
  queueFromSnapshot,
  readSessions,
  request,
  SavedSession,
  Snapshot,
  turnsFromSnapshot,
  sessionBody,
  anthropicStatus,
} from "./lib/api";
import { ago } from "./lib/time";
import { watchSession } from "./lib/session-stream";
import { imagesBody, type Attachment } from "./lib/images";
import { sessionList } from "./lib/session-list";

const storageKey = "dolly.sessions.v1";

export function WorkspaceApp() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authError, setAuthError] = useState("");
  const [setupError, setSetupError] = useState("");
  const [sessions, setSessions] = useState<readonly SavedSession[]>([]);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<typeof Snapshot.Type | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [feed, setFeed] = useState(false);
  const [details, setDetails] = useState(false);
  const [modal, setModal] = useState<"settings" | "codex" | "new" | "import" | null>(null);
  const [codex, setCodex] = useState<boolean | null>(null);
  const [anthropic, setAnthropic] = useState(false);
  const [showClaude, setShowClaude] = useState(false);
  const [error, setError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const connected = Boolean(auth?.user);
  const session = connected ? sessions.find((item) => item.id === selected) : undefined;
  const running = Boolean(snapshot && liveFromSnapshot(snapshot)?.run);
  const turns = snapshot ? turnsFromSnapshot(snapshot) : [];
  const queued = snapshot ? queueFromSnapshot(snapshot) : [];

  const rows = connected
    ? sessions.map((item) => ({
        id: item.id,
        title: item.title || "Untitled session",
        repository: item.repository,
        updatedAt: item.updatedAt,
        archived: item.archived,
        running: item.id === selected && running,
      }))
    : [];

  async function loadAuth() {
    setAuthError("");

    try {
      setAuth(await authState());
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Could not reach dolly.");
    }
  }

  useEffect(() => {
    setDetails(window.matchMedia("(min-width: 1180px)").matches);

    // GitHub App setup returns here, with an error in the query when it failed.
    const url = new URL(window.location.href);
    const failed = url.searchParams.get("github");

    if (failed !== null) {
      setSetupError(failed);
      url.searchParams.delete("github");
      window.history.replaceState(null, "", url);
    }

    void loadAuth();

    try {
      setSessions(readSessions(localStorage.getItem(storageKey) ?? "[]"));
    } catch {
      setNotice("Browser storage is unavailable. Sessions will only be listed until you reload.");
    }
  }, []);

  useEffect(() => {
    if (!connected) return;

    let active = true;

    Promise.all([
      codexLogin().catch(() => null),
      anthropicStatus().catch(() => ({ connected: false })),
    ]).then(
      ([status, claude]) => {
        if (!active) return;

        const signedIn = status?.state === "connected";
        setCodex(signedIn);
        setAnthropic(claude.connected);
        setSelected(
          (current) => current || sessionList(sessions, "", Date.now()).active[0]?.id || "",
        );

        setModal(!signedIn && !claude.connected ? "codex" : sessions.length ? null : "new");
      },
      () => active && setCodex(null),
    );

    return () => {
      active = false;
    };
    // Checked once per sign-in; the saved session list does not change who is signed in.
  }, [connected]);

  useEffect(() => {
    if (!connected || !session) {
      setSnapshot(null);

      return;
    }

    setSnapshot(null);
    setLoading(true);
    setStreamError("");

    return watchSession(
      selected,
      (value) => {
        setSnapshot(value);
        setStreamError("");
        setLoading(false);

        const activity = turnsFromSnapshot(value).flatMap((turn) => [
          turn.prompt?.at ?? 0,
          turn.startedAt ?? 0,
          turn.endedAt ?? 0,
        ]);

        const updatedAt = activity.reduce((latest, at) => Math.max(latest, at), 0);
        updateSessions((current) => {
          if (!current.some((item) => item.id === selected && updatedAt > item.updatedAt))
            return current;

          return current.map((item) =>
            item.id === selected
              ? { ...item, updatedAt: Math.max(updatedAt, item.updatedAt) }
              : item,
          );
        });
      },
      (message) => {
        setStreamError(message);
        setLoading(false);
      },
    );
  }, [selected, connected, session?.id]);

  function save(next: readonly SavedSession[]) {
    updateSessions(() => next);
  }

  function updateSessions(update: (current: readonly SavedSession[]) => readonly SavedSession[]) {
    setSessions((current) => {
      const next = update(current);

      if (next === current) return current;

      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        setNotice(
          "Could not save the session list in this browser. Keep a copy of your session ID.",
        );
      }

      return next;
    });
  }

  function select(id: string) {
    setSelected(id);
    setFeed(false);
    setMobileOpen(false);
    setError("");
    setStreamError("");
  }

  function toggleArchive(id: string) {
    const target = sessions.find((item) => item.id === id);

    if (!target) return;

    updateSessions((current) =>
      current.map((item) => (item.id === id ? { ...item, archived: !item.archived } : item)),
    );

    if (!target.archived && selected === id) {
      select(
        sessionList(
          sessions.filter((item) => item.id !== id),
          "",
          Date.now(),
        ).active[0]?.id || "",
      );
    }
  }

  function newSession() {
    setMobileOpen(false);
    setModal(codex === false && !anthropic ? "codex" : "new");
  }

  async function send(content: string, requestId: string, attachments: readonly Attachment[]) {
    setPending(true);
    setError("");

    try {
      await request(`/sessions/${encodeURIComponent(selected)}/messages`, {
        content,
        requestId,
        ...imagesBody(attachments),
      });
      updateSessions((current) =>
        current.map((item) =>
          item.id === selected ? { ...item, updatedAt: Date.now(), archived: false } : item,
        ),
      );

      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not send the message. Your draft is preserved.",
      );

      return false;
    } finally {
      setPending(false);
    }
  }

  async function steerQueued(submissionId: number) {
    setPending(true);
    setError("");

    try {
      await request(`/sessions/${encodeURIComponent(selected)}/queue/${submissionId}/steer`, {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the queued message now.");
    } finally {
      setPending(false);
    }
  }

  async function stop() {
    setPending(true);

    try {
      await request(`/sessions/${encodeURIComponent(selected)}/abort`, {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop the agent.");
    } finally {
      setPending(false);
    }
  }

  const feedback = error || streamError || notice;

  if (!auth?.user)
    return (
      <main className="gate" id="main-content">
        <div className="gate-card">
          <span className="brand-mark large" aria-hidden="true">
            D
          </span>
          {!auth ? (
            authError ? (
              <>
                <h1>Can't reach dolly</h1>
                <p role="alert" className="error-text">
                  {authError}
                </p>
                <button type="button" className="primary-button" onClick={() => void loadAuth()}>
                  Try again
                </button>
              </>
            ) : (
              <p className="muted" role="status">
                Loading…
              </p>
            )
          ) : !auth.github.connected ? (
            <>
              <h1>Set up dolly</h1>
              <GitHubSetup initialError={setupError} />
            </>
          ) : (
            <>
              <h1>Sign in to dolly</h1>
              <GitHubSignIn
                settingsUrl={auth.github.settingsUrl}
                firstRun={!auth.ownerClaimed}
                onSignedIn={(login) => setAuth({ ...auth, ownerClaimed: true, user: { login } })}
              />
            </>
          )}
        </div>
      </main>
    );

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to conversation
      </a>
      <Sidebar
        rows={rows}
        selected={selected}
        connected={connected}
        open={mobileOpen}
        feed={feed}
        onSelect={select}
        onArchive={toggleArchive}
        onNew={newSession}
        onSettings={() => {
          setMobileOpen(false);
          setModal("settings");
        }}
        onClose={() => setMobileOpen(false)}
        onFeed={() => {
          setFeed(true);
          setMobileOpen(false);
        }}
      />
      <main id="main-content" className="main-panel">
        <header className="workspace-header">
          <div className="breadcrumb">
            <IconButton
              label="Open navigation"
              aria-controls="workspace-navigation"
              aria-expanded={mobileOpen}
              className="mobile-only"
              onClick={() => setMobileOpen(true)}
            >
              <Bars3Icon />
            </IconButton>
            {session && !feed && session.repository && (
              <>
                <RepoBadge repository={session.repository} />
                <span className="breadcrumb-repo">{session.repository}</span>
                <ChevronRightIcon className="breadcrumb-chevron" />
              </>
            )}
            <h1>{feed ? "Feed" : session ? session.title || "Untitled session" : "dolly"}</h1>
          </div>
          <div className="header-actions">
            {session && !feed && (
              <IconButton
                label={session.archived ? "Restore session" : "Archive session"}
                onClick={() => toggleArchive(session.id)}
              >
                {session.archived ? <ArrowUturnLeftIcon /> : <ArchiveBoxIcon />}
              </IconButton>
            )}
            <IconButton label="New session" onClick={newSession}>
              <PlusIcon />
            </IconButton>
            {session && !feed && (
              <IconButton
                label="Toggle session details"
                aria-pressed={details}
                className={details ? "pressed" : ""}
                onClick={() => setDetails(!details)}
              >
                <ListBulletIcon />
              </IconButton>
            )}
          </div>
        </header>
        <div className="content-layout">
          <div className="conversation-panel">
            {feed ? (
              <FeedView rows={rows.filter((row) => !row.archived)} onSelect={select} />
            ) : session ? (
              <>
                <Conversation turns={turns} sessionId={session.id} loading={loading} />
                {feedback && (
                  <p
                    className={`feedback ${error || streamError ? "error-text" : ""}`}
                    role={error || streamError ? "alert" : "status"}
                  >
                    {feedback}
                  </p>
                )}
                <Composer
                  draftKey={selected}
                  onSend={send}
                  onStop={() => void stop()}
                  pending={pending}
                  running={running}
                  queued={queued}
                  onSteerQueued={(id) => void steerQueued(id)}
                  model={session.model}
                />
              </>
            ) : (
              <div className="empty-state">
                <span className="brand-mark large" aria-hidden="true">
                  D
                </span>
                <h2>
                  {codex === false && !anthropic ? "Connect a model" : "No workspace selected"}
                </h2>
                <button type="button" className="primary-button" onClick={newSession}>
                  {codex === false && !anthropic ? "Connect a model" : "New session"}
                </button>
              </div>
            )}
          </div>
          {session && !feed && details && (
            <SessionDetails
              session={session}
              running={running}
              failure={turns.at(-1)?.failure?.reason}
            />
          )}
        </div>
      </main>
      {modal === "settings" && auth?.user && auth.github.connected && (
        <SettingsModal
          login={auth.user.login}
          github={auth.github}
          codex={codex}
          onAnthropicConnection={setAnthropic}
          onClose={() => setModal(null)}
          onCodexSignIn={() => setModal("codex")}
          onCodexSignOut={() => setCodex(false)}
          onIngress={(ingress) =>
            setAuth({
              ...auth,
              github: auth.github.connected ? { ...auth.github, ingress } : auth.github,
            })
          }
          onSenders={(senders) =>
            setAuth({
              ...auth,
              github: auth.github.connected ? { ...auth.github, senders } : auth.github,
            })
          }
          onSignOut={() => {
            setAuth({ ...auth, user: null });
            setCodex(null);
            setAnthropic(false);
            setSnapshot(null);
            setModal(null);
            setNotice("");
          }}
        />
      )}
      {modal === "codex" && (
        <Modal title="Connect a model" onClose={() => setModal(null)}>
          <h3>ChatGPT subscription</h3>
          <CodexLogin
            onConnected={() => {
              setCodex(true);
              setModal(sessions.length ? null : "new");
            }}
            onCancel={() => {
              setCodex(false);
              setModal(null);
            }}
          />
          <button type="button" className="ghost-button" onClick={() => setShowClaude(!showClaude)}>
            Use Claude instead
          </button>
          {showClaude && (
            <>
              <AnthropicConnection onConnection={setAnthropic} />
              <button
                type="button"
                className="primary-button"
                disabled={!anthropic}
                onClick={() => setModal("new")}
              >
                Continue with Claude
              </button>
            </>
          )}
        </Modal>
      )}
      {modal === "new" && (
        <NewSessionComposer
          initial={
            session
              ? sessionBody(session, snapshot)
              : anthropic && !codex
                ? { model: "claude-sonnet-5-5" }
                : {}
          }
          onClose={() => setModal(null)}
          onImport={() => setModal("import")}
          onSaved={(value) => save([value, ...sessions.filter((item) => item.id !== value.id)])}
          onCreated={(value) => {
            save([value, ...sessions.filter((item) => item.id !== value.id)]);
            select(value.id);
            setModal(null);
          }}
        />
      )}
      {modal === "import" && (
        <SessionModal
          onClose={() => setModal(null)}
          onNew={() => setModal("new")}
          onCreated={(value) => {
            save([value, ...sessions.filter((item) => item.id !== value.id)]);
            select(value.id);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

function FeedView({
  rows,
  onSelect,
}: {
  rows: readonly { id: string; title: string; repository: string; updatedAt: number }[];
  onSelect: (id: string) => void;
}) {
  const now = Date.now();

  return (
    <div className="feed-view">
      {rows.length === 0 ? (
        <p className="conversation-status">No activity yet.</p>
      ) : (
        <ul className="feed-list">
          {[...rows]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((row) => (
              <li key={row.id}>
                <button type="button" onClick={() => onSelect(row.id)}>
                  <RepoBadge repository={row.repository} />
                  <span className="feed-title">{row.title}</span>
                  <span className="feed-repo">{row.repository}</span>
                  <span className="feed-time">{ago(row.updatedAt, now)}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function SessionDetails({
  session,
  running,
  failure,
}: {
  session: SavedSession;
  running: boolean;
  failure?: string;
}) {
  const [copied, setCopied] = useState(false);
  const github = /^[\w.-]+\/[\w.-]+$/.test(session.repository);

  return (
    <aside className="details-card" aria-label="Session details">
      <section>
        <h2>Status</h2>
        <p>
          <span className={`status-dot ${running ? "working" : failure ? "failed" : "idle"}`} />
          {running ? "Working" : failure === "aborted" ? "Stopped" : failure ? "Failed" : "Idle"}
        </p>
      </section>
      <section>
        <h2>Repository</h2>
        {session.repository ? (
          <p>
            <RepoBadge repository={session.repository} />
            {github ? (
              <a href={`https://github.com/${session.repository}`} target="_blank" rel="noreferrer">
                {session.repository}
              </a>
            ) : (
              session.repository
            )}
          </p>
        ) : (
          <p className="muted">None</p>
        )}
      </section>
      <section>
        <h2>Model</h2>
        <p>{session.model}</p>
      </section>
      <section>
        <h2>Session</h2>
        <p>
          <code>{session.id}</code>
          <IconButton
            label={copied ? "Session ID copied" : "Copy session ID"}
            onClick={() =>
              void navigator.clipboard.writeText(session.id).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? <CheckIcon /> : <DocumentDuplicateIcon />}
          </IconButton>
        </p>
      </section>
    </aside>
  );
}

function SettingsModal({
  login,
  github,
  codex,
  onClose,
  onCodexSignIn,
  onCodexSignOut,
  onAnthropicConnection,
  onIngress,
  onSenders,
  onSignOut,
}: {
  login: string;
  github: Extract<AuthState["github"], { connected: true }>;
  codex: boolean | null;
  onClose: () => void;
  onCodexSignIn: () => void;
  onCodexSignOut: () => void;
  onAnthropicConnection: (connected: boolean) => void;
  onIngress: (ingress: string) => void;
  onSenders: (senders: readonly string[]) => void;
  onSignOut: () => void;
}) {
  const [ingress, setIngress] = useState(github.ingress ?? "");
  const [accounts, setAccounts] = useState("");
  const [senders, setSenders] = useState(github.senders.join(", "));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;

    request("/integrations/github/accounts").then(
      (text) => {
        const result = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ accounts: Schema.Array(Schema.String) })),
        )(text);

        if (active) setAccounts(result.accounts.join(", "));
      },
      (cause) =>
        active &&
        setError(cause instanceof Error ? cause.message : "Could not load allowed accounts."),
    );

    return () => {
      active = false;
    };
  }, []);

  /** Logins from a comma- or space-separated list, without a leading @. */
  function logins(value: string) {
    return value
      .split(/[\s,]+/)
      .map((login) => login.replace(/^@/, ""))
      .filter(Boolean);
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
        onSenders(next);
      }

      setSaved("access");
    }, "Could not save GitHub access.");
  }

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
      onIngress(result.ingress);
      setSaved("ingress");
    }, "Could not update the ingress URL.");
  }

  return (
    <Modal title="Settings" onClose={onClose}>
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
              onSignOut();
            }, "Could not sign out.")
          }
        >
          Sign out
        </button>
      </div>
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
                onCodexSignOut();
              }, "Could not sign out of ChatGPT.");
            }}
          >
            Sign out
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={onCodexSignIn}>
            Sign in
          </button>
        )}
      </div>
      <AnthropicConnection onConnection={onAnthropicConnection} />
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
      <h3>Repositories</h3>
      <RepositoryPicker manage />
      <form onSubmit={saveIngress}>
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
      <form onSubmit={saveAccess}>
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
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </Modal>
  );
}

function SessionModal({
  onClose,
  onNew,
  onCreated,
}: {
  onClose: () => void;
  onNew: () => void;
  onCreated: (session: SavedSession) => void;
}) {
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      const text = await request(`/sessions/${encodeURIComponent(id.trim())}`);
      Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(text);

      onCreated({
        id: id.trim(),
        model: "Existing session",
        title: title.trim(),
        repository: "",
        updatedAt: Date.now(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the session.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title="Open an existing session" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="workspace-title">Session name</label>
        <Input
          id="workspace-title"
          name="title"
          placeholder="What are we working on?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={120}
        />
        <label htmlFor="session-id">Session ID</label>
        <Input
          id="session-id"
          name="sessionId"
          value={id}
          onChange={(event) => setId(event.target.value)}
          required
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              onNew();
              setError("");
            }}
          >
            <LinkIcon />
            New session
          </button>
          <button type="submit" className="primary-button" disabled={pending}>
            {pending ? "Opening…" : "Open session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
