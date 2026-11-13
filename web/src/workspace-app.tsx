import { useEffect, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import {
  Bars3Icon,
  CheckCircleIcon,
  ChevronRightIcon,
  CodeBracketIcon,
  CommandLineIcon,
  LinkIcon,
  PlusIcon,
  RectangleGroupIcon,
  SignalIcon,
} from "@heroicons/react/16/solid";
import { Sidebar } from "./components/sidebar";
import { Composer, Conversation } from "./components/conversation";
import { IconButton, Input, Modal, Select } from "./components/ui";
import {
  messagesFromSnapshot,
  liveFromSnapshot,
  readSessions,
  request,
  SavedSession,
  Session,
  Snapshot,
  type ApiBody,
} from "./lib/api";
import { previewMessages, previewSessions } from "./lib/preview";

const storageKey = "pi-hard.sessions.v1";

export function WorkspaceApp() {
  const [token, setToken] = useState("");
  const [sessions, setSessions] = useState<readonly SavedSession[]>([]);
  const [selected, setSelected] = useState("presence");
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
  const session = sessions.find((item) => item.id === selected);
  const example = previewSessions.find((item) => item.id === selected) ?? previewSessions[0];
  const title = connected ? (session?.title ?? "Your coding workspace") : example.title;
  const repository = connected ? session?.repository || "No repository" : example.repository;
  const model = connected ? (session?.model ?? "Default model") : "gpt-6-sol";

  const rows = connected
    ? sessions.map((item) => ({ ...item, status: "Saved", time: "" }))
    : previewSessions;

  const messages = connected
    ? snapshot
      ? messagesFromSnapshot(snapshot)
      : []
    : selected === "presence"
      ? previewMessages
      : [];

  useEffect(() => {
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

  async function send(content: string, requestId: string) {
    if (!session) {
      setModal("new");

      return false;
    }

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
      setNotice("Message queued. The transcript refreshes automatically.");

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
      setNotice("Stop requested for this session and its child agents.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop the agent.");
    } finally {
      setPending(false);
    }
  }

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
        onNew={() => setModal(connected ? "new" : "connect")}
        onSettings={() => setModal("connect")}
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
            <span className="repo-icon">
              <CodeBracketIcon />
            </span>
            <span className="breadcrumb-repo">{repository}</span>
            <ChevronRightIcon className="breadcrumb-chevron" />
            <h1>{feed ? "Activity feed" : title}</h1>
          </div>
          <div className="header-actions">
            <span className="connection-badge">
              <span className={`tiny-dot ${connected ? "green" : ""}`} />
              {connected ? "Connected" : "Preview"}
            </span>
            <IconButton
              label="New workspace"
              onClick={() => setModal(connected ? "new" : "connect")}
            >
              <PlusIcon />
            </IconButton>
            <IconButton
              label="Toggle session details"
              aria-pressed={details}
              onClick={() => setDetails(!details)}
            >
              <RectangleGroupIcon />
            </IconButton>
          </div>
        </header>
        <div className="session-strip">
          <span>
            <span className="tiny-dot green" />
            {connected ? "Personal workspace" : "A little less setup. A lot more shipping."}
          </span>
          <button type="button" onClick={() => setModal(connected ? "import" : "connect")}>
            {connected ? "Open a session" : "Connect your API"}
            <ChevronRightIcon />
          </button>
        </div>
        <div className="content-layout">
          <div className="conversation-panel">
            {feed ? (
              <div className="feed-view">
                <div className="feed-heading">
                  <p className="eyebrow">Your workspace</p>
                  <h2>Pick up where you left off.</h2>
                  <p>
                    {connected
                      ? "Sessions saved in this browser."
                      : "A preview of your agents’ work, all in one place."}
                  </p>
                </div>
                <div className="feed-list">
                  {rows.map((row) => (
                    <button key={row.id} type="button" onClick={() => select(row.id)}>
                      <span className="feed-status">
                        <CheckCircleIcon />
                      </span>
                      <span>
                        <strong>{row.title}</strong>
                        <span>
                          {row.repository} · {row.status}
                        </span>
                      </span>
                      <ChevronRightIcon />
                    </button>
                  ))}
                  {rows.length === 0 && <p>No sessions yet. Create a workspace to get started.</p>}
                </div>
              </div>
            ) : (
              <>
                <Conversation
                  messages={messages}
                  preview={!connected}
                  previewPrimary={!connected && selected === "presence"}
                  title={title}
                  loading={loading}
                />
                <div className="feedback" aria-live="polite">
                  {error || pollError ? (
                    <p className="error-text" role="alert">
                      {error || pollError}
                    </p>
                  ) : snapshot && liveFromSnapshot(snapshot)?.run ? (
                    <p>Agent is working…</p>
                  ) : notice ? (
                    <p>{notice}</p>
                  ) : null}
                </div>
                <Composer
                  key={connected ? "live" : "preview"}
                  draftKey={selected}
                  onSend={send}
                  onStop={() => void stop()}
                  pending={pending}
                  preview={!connected}
                  onConnect={() => setModal("connect")}
                  model={model}
                />
              </>
            )}
          </div>
          {details && (
            <aside className="details-panel" aria-label="Session details">
              <p className="eyebrow">Workspace details</p>
              <h2>{title}</h2>
              <dl>
                <dt>Repository</dt>
                <dd>{repository}</dd>
                <dt>Model</dt>
                <dd>{model}</dd>
                <dt>Session</dt>
                <dd>{connected ? (session?.id ?? "No session selected") : "Example session"}</dd>
                <dt>Connection</dt>
                <dd>{connected ? "Authenticated API" : "Preview · no live requests"}</dd>
              </dl>
              {snapshot?.before && (
                <p className="muted">Showing the most recent transcript window.</p>
              )}
              {snapshot && (
                <details>
                  <summary>Raw session snapshot</summary>
                  <pre>{JSON.stringify(snapshot, null, 2)}</pre>
                </details>
              )}
              <div className="details-note">
                <SignalIcon />
                <p>
                  Real sessions survive Worker restarts. Your session list is saved only in this
                  browser.
                </p>
              </div>
            </aside>
          )}
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
            select("presence");
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
    <Modal title="Connect your workspace" onClose={onClose}>
      <div className="modal-intro">
        <CommandLineIcon />
        <p>Use your pi-hard API token to start real coding sessions.</p>
      </div>
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
          Kept in memory only, never saved in browser storage. Cloudflare Access must also authorize
          your browser.
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
            {pending ? "Connecting…" : "Connect API"}
          </button>
        </div>
      </form>
      <p className="modal-footnote">
        Local development proxies /api to localhost:8787. Production must serve the UI and protected
        API on the same origin.
      </p>
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
      <p className="modal-description">
        {mode === "new"
          ? "One task, one agent, a workspace of its own."
          : "Add a known session to this browser’s workspace list."}
      </p>
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
            <p className="field-help">
              Uses your connected Codex subscription and GitHub App. No extra network hosts are
              granted.
            </p>
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
