import { useEffect, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import { Bars3Icon, CheckIcon, ChevronRightIcon, LinkIcon } from "@heroicons/react/16/solid";
import { DocumentDuplicateIcon, ListBulletIcon, PlusIcon } from "@heroicons/react/24/outline";
import { Sidebar } from "./components/sidebar";
import { Composer, Conversation } from "./components/conversation";
import { IconButton, Input, Modal, RepoBadge, Select } from "./components/ui";
import { CodexLogin } from "./components/codex-login";
import { GitHubSetup, GitHubSignIn, ingressHook } from "./components/github";
import {
  authState,
  codexLogin,
  type AuthState,
  liveFromSnapshot,
  readSessions,
  request,
  SavedSession,
  Session,
  Snapshot,
  turnsFromSnapshot,
  type ApiBody,
} from "./lib/api";
import { ago } from "./lib/time";

const storageKey = "pi-hard.sessions.v1";

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
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const connected = Boolean(auth?.user);
  const session = connected ? sessions.find((item) => item.id === selected) : undefined;
  const running = Boolean(snapshot && liveFromSnapshot(snapshot)?.run);
  const turns = snapshot ? turnsFromSnapshot(snapshot) : [];

  const rows = connected
    ? sessions.map((item) => ({
        id: item.id,
        title: item.title || "Untitled workspace",
        repository: item.repository,
        updatedAt: item.updatedAt,
        running: item.id === selected && running,
      }))
    : [];

  async function loadAuth() {
    setAuthError("");

    try {
      setAuth(await authState());
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Could not reach pi-hard.");
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

    codexLogin().then(
      (status) => {
        if (!active) return;

        const signedIn = status.state === "connected";
        setCodex(signedIn);
        setSelected((current) => current || sessions[0]?.id || "");

        setModal(!signedIn ? "codex" : sessions.length ? null : "new");
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

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(null);
    setLoading(true);

    async function poll() {
      try {
        const text = await request(
          `/sessions/${encodeURIComponent(selected)}`,
          undefined,
          controller.signal,
        );

        const value = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(text);

        if (!controller.signal.aborted) {
          setSnapshot(value);
          setPollError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setPollError(cause instanceof Error ? cause.message : "Could not load the session.");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void poll(), 2500);
        }
      }
    }

    void poll();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected, connected, session?.id]);

  function save(next: readonly SavedSession[]) {
    setSessions(next);

    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setNotice("Could not save the session list in this browser. Keep a copy of your session ID.");
    }
  }

  function select(id: string) {
    setSelected(id);
    setFeed(false);
    setMobileOpen(false);
    setError("");
    setPollError("");
  }

  function newWorkspace() {
    setMobileOpen(false);
    setModal(codex === false ? "codex" : "new");
  }

  async function send(content: string, requestId: string) {
    setPending(true);
    setError("");

    try {
      await request(`/sessions/${encodeURIComponent(selected)}/messages`, {
        content,
        requestId,
      });
      save(
        sessions.map((item) => (item.id === selected ? { ...item, updatedAt: Date.now() } : item)),
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

  const feedback = error || pollError || notice;

  if (!auth?.user)
    return (
      <main className="gate" id="main-content">
        <div className="gate-card">
          <span className="brand-mark large" aria-hidden="true">
            π
          </span>
          {!auth ? (
            authError ? (
              <>
                <h1>Can't reach pi-hard</h1>
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
              <h1>Set up pi-hard</h1>
              <GitHubSetup initialError={setupError} />
            </>
          ) : (
            <>
              <h1>Sign in to pi-hard</h1>
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
        onNew={newWorkspace}
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
            <h1>{feed ? "Feed" : session ? session.title || "Untitled workspace" : "pi-hard"}</h1>
          </div>
          <div className="header-actions">
            <IconButton label="New workspace" onClick={newWorkspace}>
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
              <FeedView rows={rows} onSelect={select} />
            ) : session ? (
              <>
                <Conversation turns={turns} sessionId={session.id} loading={loading} />
                {feedback && (
                  <p
                    className={`feedback ${error || pollError ? "error-text" : ""}`}
                    role={error || pollError ? "alert" : "status"}
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
                  model={session.model}
                />
              </>
            ) : (
              <div className="empty-state">
                <span className="brand-mark large" aria-hidden="true">
                  π
                </span>
                <h2>{codex === false ? "Sign in to ChatGPT" : "No workspace selected"}</h2>
                <button type="button" className="primary-button" onClick={newWorkspace}>
                  {codex === false ? "Sign in with ChatGPT" : "New workspace"}
                </button>
              </div>
            )}
          </div>
          {session && !feed && details && <SessionDetails session={session} running={running} />}
        </div>
      </main>
      {modal === "settings" && auth?.user && auth.github.connected && (
        <SettingsModal
          login={auth.user.login}
          github={auth.github}
          codex={codex}
          onClose={() => setModal(null)}
          onCodexSignIn={() => setModal("codex")}
          onCodexSignOut={() => setCodex(false)}
          onIngress={(ingress) =>
            setAuth({
              ...auth,
              github: auth.github.connected ? { ...auth.github, ingress } : auth.github,
            })
          }
          onSignOut={() => {
            setAuth({ ...auth, user: null });
            setCodex(null);
            setSnapshot(null);
            setModal(null);
            setNotice("");
          }}
        />
      )}
      {modal === "codex" && (
        <Modal title="Sign in to ChatGPT" onClose={() => setModal(null)}>
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
        </Modal>
      )}
      {(modal === "new" || modal === "import") && (
        <SessionModal
          mode={modal}
          onClose={() => setModal(null)}
          onMode={setModal}
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

function SessionDetails({ session, running }: { session: SavedSession; running: boolean }) {
  const [copied, setCopied] = useState(false);
  const github = /^[\w.-]+\/[\w.-]+$/.test(session.repository);

  return (
    <aside className="details-card" aria-label="Session details">
      <section>
        <h2>Status</h2>
        <p>
          <span className={`status-dot ${running ? "working" : "idle"}`} />
          {running ? "Working" : "Idle"}
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
  onIngress,
  onSignOut,
}: {
  login: string;
  github: Extract<AuthState["github"], { connected: true }>;
  codex: boolean | null;
  onClose: () => void;
  onCodexSignIn: () => void;
  onCodexSignOut: () => void;
  onIngress: (ingress: string) => void;
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

      if (logins(senders).length)
        await request(
          "/integrations/github/webhook",
          { senders: logins(senders) },
          undefined,
          "PUT",
        );
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
              if (!confirm("Sign out of ChatGPT? Agents can't run until you sign in again."))
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
        <label htmlFor="settings-accounts">Accounts pi-hard can work in</label>
        <Input
          id="settings-accounts"
          name="accounts"
          placeholder={github.owner}
          value={accounts}
          onChange={(event) => {
            setAccounts(event.target.value);
            setSaved("");
          }}
          aria-describedby="settings-accounts-help"
        />
        <p id="settings-accounts-help" className="field-help">
          GitHub users and organizations whose repositories agents may use, separated by commas.
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
  mode,
  onClose,
  onMode,
  onCreated,
}: {
  mode: "new" | "import";
  onClose: () => void;
  onMode: (mode: "new" | "import") => void;
  onCreated: (session: SavedSession) => void;
}) {
  const [title, setTitle] = useState("");
  const [repository, setRepository] = useState("");
  const [model, setModel] = useState("");
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      let result: typeof Session.Type;

      if (mode === "import") {
        const text = await request(`/sessions/${encodeURIComponent(id.trim())}`);
        Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(text);
        result = { id: id.trim(), model: "Existing session" };
      } else {
        const body: ApiBody = {};

        if (model) body.model = model;

        if (repository.trim()) body.workspace = { repository: repository.trim() };
        const text = await request("/sessions", body);
        result = Schema.decodeUnknownSync(Schema.fromJsonString(Session))(text);
      }

      onCreated({
        ...result,
        title: title.trim(),
        repository: repository.trim(),
        updatedAt: Date.now(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the session.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title={mode === "new" ? "New workspace" : "Open an existing session"} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="workspace-title">Workspace name</label>
        <Input
          id="workspace-title"
          name="title"
          placeholder="What are we working on?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={120}
        />
        {mode === "import" ? (
          <>
            <label htmlFor="session-id">Session ID</label>
            <Input
              id="session-id"
              name="sessionId"
              value={id}
              onChange={(event) => setId(event.target.value)}
              required
            />
          </>
        ) : (
          <>
            <label htmlFor="repository">
              GitHub repository <span className="muted">(optional)</span>
            </label>
            <Input
              id="repository"
              name="repository"
              placeholder="owner/repository"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              pattern="[^/\s]+/[^/\s]+"
            />
            <label htmlFor="model">Model</label>
            <Select
              id="model"
              name="model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">Server default</option>
              <option value="gpt-6-sol">GPT-6 Sol</option>
              <option value="gpt-6-luna">GPT-6 Luna</option>
              <option value="gpt-6.1-terra">GPT-6.1 Terra</option>
            </Select>
          </>
        )}
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
              onMode(mode === "new" ? "import" : "new");
              setError("");
            }}
          >
            <LinkIcon />
            {mode === "new" ? "Open existing" : "Create new"}
          </button>
          <button type="submit" className="primary-button" disabled={pending}>
            {pending ? "Opening…" : mode === "new" ? "Create workspace" : "Open session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
