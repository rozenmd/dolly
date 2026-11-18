import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Bars3Icon, ChevronRightIcon, LinkIcon } from "@heroicons/react/16/solid";
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  InboxArrowDownIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { Sidebar } from "./components/sidebar";
import { Composer, Conversation } from "./components/conversation";
import { IconButton, Input, Modal, RepoBadge } from "./components/ui";
import { CodexLogin } from "./components/codex-login";
import { GitHubSetup, GitHubSignIn } from "./components/github";
import { NewSessionComposer } from "./components/new-session";
import { AnthropicConnection } from "./components/anthropic";
import {
  authState,
  codexLogin,
  type AuthState,
  liveFromSnapshot,
  queueFromSnapshot,
  historyPage,
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
import { extendTranscript, prependHistory } from "./lib/transcript-history";
import { imagesBody, type Attachment } from "./lib/images";
import { sessionList } from "./lib/session-list";
import { belongsInSidebar, sessionThreads, sidebarSelection } from "./lib/session-threads";
import { SessionSummaryCard, SessionSummaryToggle } from "./components/session-summary";
import { useSessionSummary } from "./lib/session-summary";

const storageKey = "dolly.sessions.v1";

export function WorkspaceApp() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authError, setAuthError] = useState("");
  const [setupError, setSetupError] = useState("");
  const [sessions, setSessions] = useState<readonly SavedSession[]>([]);
  const sessionRevision = useRef(0);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<typeof Snapshot.Type | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [feed, setFeed] = useState(false);
  const [modal, setModal] = useState<"codex" | "new" | "import" | null>(null);
  const navigate = useNavigate();
  const [codex, setCodex] = useState<boolean | null>(null);
  const [anthropic, setAnthropic] = useState(false);
  const [showClaude, setShowClaude] = useState(false);
  const [error, setError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  // The `before` an older-history request is in flight for, so one scroll asks once.
  const [olderThrough, setOlderThrough] = useState<number>();
  const [olderError, setOlderError] = useState("");
  const connected = Boolean(auth?.user);
  const session = connected ? sessions.find((item) => item.id === selected) : undefined;
  const summary = useSessionSummary();
  const summaryShown = Boolean(session && !feed && summary.open);
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
        // The open session streams live state; others rely on the polled list.
        running: item.id === selected && snapshot ? running : Boolean(item.running),
        pullRequest: item.pullRequest,
        parentId: item.parentId,
        kept: item.kept,
      }))
    : [];

  // Spawned sessions live with their parent, not in the sidebar (see lib/session-threads).
  const sidebarRows = rows.filter(belongsInSidebar);

  const parent = session?.parentId
    ? sessions.find((item) => item.id === session.parentId)
    : undefined;

  async function loadAuth() {
    setAuthError("");

    try {
      setAuth(await authState());
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Could not reach dolly.");
    }
  }

  useEffect(() => {
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
      setNotice("Browser storage is unavailable. Sessions will be loaded from the server.");
    }
  }, []);

  useEffect(() => {
    if (!connected) return;

    let active = true;
    const revision = sessionRevision.current;

    Promise.all([
      codexLogin().catch(() => null),
      anthropicStatus().catch(() => ({ connected: false })),
      (async () => {
        try {
          for (let offset = 0; offset < sessions.length; offset += 50) {
            await request("/sessions/import", { sessions: sessions.slice(offset, offset + 50) });
          }
        } catch {
          if (active)
            setNotice(
              "Could not import browser archive choices. Server sessions will still be loaded.",
            );
        }

        const saved = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SavedSession)))(
          await request("/sessions"),
        );

        if (active) setSessionError("");

        return saved;
      })().catch((cause) => {
        if (active)
          setSessionError(
            `Could not sync sessions: ${cause instanceof Error ? cause.message : "Server unavailable"}`,
          );

        return sessions;
      }),
    ]).then(
      ([status, claude, saved]) => {
        if (!active) return;

        const signedIn = status?.state === "connected";
        setCodex(signedIn);
        setAnthropic(claude.connected);

        if (sessionRevision.current !== revision) {
          // Do not replace sessions created or changed while sign-in discovery was in flight.
          updateSessions((current) => [
            ...current,
            ...saved.filter((item) => !current.some((local) => local.id === item.id)),
          ]);

          return;
        }

        save(saved);
        setSelected(
          (current) =>
            current ||
            sessionList(saved.filter(belongsInSidebar), "", Date.now()).active[0]?.id ||
            "",
        );

        setModal(!signedIn && !claude.connected ? "codex" : saved.length ? null : "new");
      },
      () => active && setCodex(null),
    );

    return () => {
      active = false;
    };
    // Checked once per sign-in; the saved session list does not change who is signed in.
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    let active = true;

    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      const revision = sessionRevision.current;

      try {
        const saved = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SavedSession)))(
          await request("/sessions"),
        );

        if (active) {
          setSessionError("");

          if (sessionRevision.current === revision) save(saved);
        }
      } catch (cause) {
        if (active)
          setSessionError(
            `Could not sync sessions: ${cause instanceof Error ? cause.message : "Server unavailable"}`,
          );
      }
    };

    const timer = window.setInterval(() => void refresh(), 15_000);
    window.addEventListener("focus", refresh);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [connected]);

  useEffect(() => {
    if (!connected || !session) {
      setSnapshot(null);

      return;
    }

    setSnapshot(null);
    setLoading(true);
    setStreamError("");
    setOlderThrough(undefined);
    setOlderError("");

    return watchSession(
      selected,
      (value) => {
        setSnapshot((held) => extendTranscript(held, value));
        setStreamError("");
        setLoading(false);

        // Only human prompts reorder the sidebar; agent activity would make it jump around.
        const updatedAt = turnsFromSnapshot(value).reduce(
          (latest, turn) => Math.max(latest, turn.prompt?.at ?? 0),
          0,
        );

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
      sessionRevision.current++;

      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        setNotice(
          "Could not cache the session list in this browser. Your sessions are still on the server.",
        );
      }

      return next;
    });
  }

  /** Fetches the page before the oldest held entry, as the reader scrolls back toward the first prompt. */
  async function loadOlder() {
    const through = snapshot?.before;

    if (through === undefined || olderThrough === through) return;

    const id = selected;
    setOlderThrough(through);
    setOlderError("");

    try {
      const page = await historyPage(id, through);

      // Entry IDs are unique per Dolly instance, so a page for another session never matches `before`.
      setSnapshot((held) => (held ? prependHistory(held, through, page) : held));
    } catch (cause) {
      setOlderError(cause instanceof Error ? cause.message : "Could not load earlier messages.");
    } finally {
      setOlderThrough((current) => (current === through ? undefined : current));
    }
  }

  function select(id: string) {
    setSelected(id);
    setFeed(false);
    setMobileOpen(false);
    setError("");
    setStreamError("");
  }

  async function toggleArchive(id: string) {
    const target = sessions.find((item) => item.id === id);

    if (!target) return;

    try {
      await request(
        `/sessions/${encodeURIComponent(id)}`,
        { archived: !target.archived },
        undefined,
        "PUT",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sync archive state.");

      return;
    }

    updateSessions((current) =>
      current.map((item) => (item.id === id ? { ...item, archived: !target.archived } : item)),
    );

    if (!target.archived && selected === id) {
      select(
        sessionList(
          sessions.filter((item) => item.id !== id && belongsInSidebar(item)),
          "",
          Date.now(),
        ).active[0]?.id || "",
      );
    }
  }

  /** opensession's "Keep in sidebar": a spawned session gets a row of its own. */
  async function toggleKept(id: string) {
    const target = sessions.find((item) => item.id === id);

    if (!target?.parentId) return;
    const kept = !target.kept;

    try {
      await request(`/sessions/${encodeURIComponent(id)}`, { kept }, undefined, "PUT");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the sidebar.");

      return;
    }

    updateSessions((current) => current.map((item) => (item.id === id ? { ...item, kept } : item)));
  }

  async function setThinkingLevel(level: string) {
    const id = selected;
    const previous = sessions.find((item) => item.id === id)?.thinkingLevel;

    const apply = (value: string | undefined) =>
      updateSessions((current) =>
        current.map((item) => (item.id === id ? { ...item, thinkingLevel: value } : item)),
      );

    apply(level);

    try {
      await request(
        `/sessions/${encodeURIComponent(id)}/settings`,
        { thinkingLevel: level },
        undefined,
        "PUT",
      );
    } catch (cause) {
      apply(previous);
      setError(cause instanceof Error ? cause.message : "Could not change thinking effort.");
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

  const feedback = error || streamError || sessionError || notice;

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
        rows={sidebarRows}
        selected={sidebarSelection(sessions, selected)}
        connected={connected}
        open={mobileOpen}
        feed={feed}
        onSelect={select}
        onArchive={toggleArchive}
        onNew={newSession}
        onSettings={() => {
          setMobileOpen(false);
          void navigate({ to: "/settings" });
        }}
        onClose={() => setMobileOpen(false)}
        onFeed={() => {
          setFeed(true);
          setMobileOpen(false);
        }}
      />
      <main
        id="main-content"
        ref={summary.paneRef}
        className={`main-panel ${summaryShown && summary.standing ? "summary-standing" : ""}`}
      >
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
            {session && !feed && parent && (
              <>
                <button
                  type="button"
                  className="breadcrumb-parent"
                  title={`Spawned by ${parent.title || "Untitled session"}`}
                  onClick={() => select(parent.id)}
                >
                  {parent.title || "Untitled session"}
                </button>
                <ChevronRightIcon className="breadcrumb-chevron" />
              </>
            )}
            <h1>{feed ? "Feed" : session ? session.title || "Untitled session" : "dolly"}</h1>
          </div>
          <div className="header-actions">
            {session && !feed && session.parentId && (
              <IconButton
                label={session.kept ? "Remove from sidebar" : "Keep in sidebar"}
                aria-pressed={Boolean(session.kept)}
                className={session.kept ? "pressed" : ""}
                onClick={() => void toggleKept(session.id)}
              >
                <InboxArrowDownIcon />
              </IconButton>
            )}
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
            {session && !feed && <SessionSummaryToggle summary={summary} />}
          </div>
        </header>
        <div className="content-layout">
          <div className="conversation-panel">
            {feedback && (
              <p
                className={`feedback ${error || streamError || sessionError ? "error-text" : ""}`}
                role={error || streamError || sessionError ? "alert" : "status"}
              >
                {feedback}
              </p>
            )}
            {feed ? (
              <FeedView rows={rows.filter((row) => !row.archived)} onSelect={select} />
            ) : session ? (
              <>
                <Conversation
                  turns={turns}
                  sessionId={session.id}
                  loading={loading}
                  older={{
                    before: snapshot?.before,
                    loading: olderThrough !== undefined,
                    error: olderError,
                    load: () => void loadOlder(),
                  }}
                  thread={(id) => rows.find((row) => row.id === id)}
                  onOpenThread={select}
                />
                <Composer
                  draftKey={selected}
                  onSend={send}
                  onStop={() => void stop()}
                  pending={pending}
                  running={running}
                  queued={queued}
                  onSteerQueued={(id) => void steerQueued(id)}
                  model={session.model}
                  thinkingLevel={session.thinkingLevel}
                  onThinkingLevel={(level) => void setThinkingLevel(level)}
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
        </div>
        {session && summaryShown && (
          <SessionSummaryCard
            summary={summary}
            session={session}
            running={running}
            failure={turns.at(-1)?.failure?.reason}
            threads={sessionThreads(
              rows.filter((row) => !row.archived),
              session.id,
            )}
            onOpenThread={select}
          />
        )}
      </main>
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
          initial={session ? sessionBody(session, snapshot) : {}}
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
