import { useEffect, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import { Bars3Icon, CheckIcon, ChevronRightIcon, LinkIcon } from "@heroicons/react/16/solid";
import { DocumentDuplicateIcon, ListBulletIcon, PlusIcon } from "@heroicons/react/24/outline";
import { Sidebar } from "./components/sidebar";
import { Composer, Conversation } from "./components/conversation";
import { IconButton, Input, Modal, RepoBadge, Select } from "./components/ui";
import {
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
  const [token, setToken] = useState("");
  const [sessions, setSessions] = useState<readonly SavedSession[]>([]);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<typeof Snapshot.Type | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [feed, setFeed] = useState(false);
  const [details, setDetails] = useState(false);
  const [modal, setModal] = useState<"connect" | "new" | "import" | null>(null);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const connected = Boolean(token);
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

  useEffect(() => {
    setDetails(window.matchMedia("(min-width: 1180px)").matches);

    try {
      setSessions(readSessions(localStorage.getItem(storageKey) ?? "[]"));
    } catch {
      setNotice("Browser storage is unavailable. Sessions will only be listed until you reload.");
    }
  }, []);

  useEffect(() => {
    if (!token || !session) {
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
          token,
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
  }, [selected, token, session?.id]);

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
    setModal(connected ? "new" : "connect");
  }

  async function send(content: string, requestId: string) {
    setPending(true);
    setError("");

    try {
      await request(`/sessions/${encodeURIComponent(selected)}/messages`, token, {
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
      await request(`/sessions/${encodeURIComponent(selected)}/abort`, token, {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop the agent.");
    } finally {
      setPending(false);
    }
  }

  const feedback = error || pollError || notice;

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
          setModal("connect");
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
                <h2>{connected ? "No workspace selected" : "Connect to pi-hard"}</h2>
                <button type="button" className="primary-button" onClick={newWorkspace}>
                  {connected ? "New workspace" : "Connect"}
                </button>
              </div>
            )}
          </div>
          {session && !feed && details && <SessionDetails session={session} running={running} />}
        </div>
      </main>
      {modal === "connect" && (
        <ConnectModal
          connected={connected}
          onClose={() => setModal(null)}
          onConnect={(value) => {
            setToken(value);
            setSelected(sessions[0]?.id ?? "");
            setSnapshot(null);
            setModal(sessions.length ? null : "new");
            setNotice("");
            setError("");
          }}
          onDisconnect={() => {
            setToken("");
            select("");
            setModal(null);
            setNotice("");
          }}
        />
      )}
      {(modal === "new" || modal === "import") && (
        <SessionModal
          mode={modal}
          token={token}
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

function ConnectModal({
  connected,
  onClose,
  onConnect,
  onDisconnect,
}: {
  connected: boolean;
  onClose: () => void;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");

    try {
      await request("/integrations/github", value.trim());
      onConnect(value.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to your API.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title={connected ? "Connection" : "Connect"} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="api-token">API token</label>
        <Input
          id="api-token"
          name="token"
          type="password"
          autoComplete="off"
          required
          minLength={32}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-describedby="token-help"
        />
        <p id="token-help" className="field-help">
          Kept in this tab only.
        </p>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {connected && (
            <button type="button" className="secondary-button" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
          <button type="submit" className="primary-button" disabled={pending}>
            {pending ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SessionModal({
  mode,
  token,
  onClose,
  onMode,
  onCreated,
}: {
  mode: "new" | "import";
  token: string;
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
        const text = await request(`/sessions/${encodeURIComponent(id.trim())}`, token);
        Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(text);
        result = { id: id.trim(), model: "Existing session" };
      } else {
        const body: ApiBody = {};

        if (model) body.model = model;

        if (repository.trim()) body.workspace = { repository: repository.trim() };
        const text = await request("/sessions", token, body);
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
