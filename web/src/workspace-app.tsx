import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMatch, useNavigate, useParams } from "@tanstack/react-router";
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
import { ChatGPTLogin } from "./components/chatgpt-login";
import { GitHubSetup, GitHubSignIn } from "./components/github";
import { GetStarted } from "./components/get-started";
import { NewSessionComposer } from "./components/new-session";
import {
  DEFAULT_EFFORT,
  ModelControl,
  normalizeEffort,
  type Speed,
} from "./components/model-select";
import { AnthropicConnection } from "./components/anthropic";
import {
  authState,
  chatgptLogin,
  type AuthState,
  liveFromSnapshot,
  queueFromSnapshot,
  historyPage,
  promptIndex,
  readSessions,
  request,
  SavedSession,
  Snapshot,
  turnsFromSnapshot,
  sessionBody,
  anthropicStatus,
  defaultModel,
  type DefaultModel,
} from "./lib/api";
import { ago } from "./lib/time";
import { watchSession, watchSessions } from "./lib/session-stream";
import { extendTranscript, prependHistory } from "./lib/transcript-history";
import { indexedMarks, type RailMark } from "./lib/turn-rail";
import { imagesBody, type Attachment } from "./lib/images";
import { sessionList } from "./lib/session-list";
import { automated, belongsInSidebar, rootSession, sessionThreads } from "./lib/session-threads";
import { SessionSummaryCard, SessionSummaryToggle } from "./components/session-summary";
import { useSessionSummary } from "./lib/session-summary";
import { workspaceMain, workspaceOf, workspaceRows, workspaceTabs } from "./lib/workspaces";

const cacheStorageKey = "dolly.sessions.cache.v1";
const decodeSessions = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SavedSession)));

/** Model settings the composer can change on a session; each applies from the next request. */
type SessionChange = {
  model?: string;
  thinkingLevel?: string;
  speed?: Speed;
  autoFallback?: boolean;
};

export function WorkspaceApp() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authError, setAuthError] = useState("");
  const [setupError, setSetupError] = useState("");
  const [sessions, setSessions] = useState<readonly SavedSession[]>([]);
  const sessionListRef = useRef(sessions);
  const [sessionsReady, setSessionsReady] = useState(false);
  const startupPrompted = useRef(false);
  // The session the URL names: /workspace/<workspaceId>/session/<sessionId>, or /session/<sessionId>.
  const params = useParams({ strict: false });
  const routed = params.sessionId ?? "";
  const [selected, setSelected] = useState(routed);
  const [snapshot, setSnapshot] = useState<typeof Snapshot.Type | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  // The feed has its own URL, /feed, so it survives reloads and can be linked to. Read from the
  // route match, not the location, so it changes in step with `params` on back/forward.
  const feed = Boolean(useMatch({ from: "/_app/feed", shouldThrow: false }));
  const [modal, setModal] = useState<"chatgpt" | "new" | "import" | null>(null);
  // The workspace a new session joins; undefined starts a new workspace.
  const [joining, setJoining] = useState<string>();
  const navigate = useNavigate();
  const [chatgpt, setChatGPT] = useState<boolean | null>(null);
  const [anthropic, setAnthropic] = useState(false);
  const [defaults, setDefaults] = useState<DefaultModel | null>(null);
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

  // Rail marks for the prompts at or before `through`, so the rail reaches turns not loaded yet.
  const [railIndex, setRailIndex] = useState<{
    session: string;
    through: number;
    marks: readonly RailMark[];
  }>();

  const indexing = useRef<string>(undefined);
  const before = snapshot?.before;
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
        automationRun: item.automationRun?.name,
        parentId: item.parentId,
        kept: item.kept,
        automation: item.automation,
        workspaceId: item.workspaceId,
        createdAt: item.createdAt,
      }))
    : [];

  const workspace = session ? workspaceOf(sessions, session.id) : "";

  // One row per workspace; spawned sessions live with their parent. A workspace of only automatic
  // reviews is left out unless open; writable work started in one keeps it (lib/session-threads).
  const sidebarRows = workspaceRows(rows).filter(
    (row) => row.id === workspace || !row.sessions.every(automated),
  );

  const tabs = workspace ? workspaceTabs(rows, workspace) : [];

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

    try {
      const cached = readSessions(localStorage.getItem(cacheStorageKey) ?? "[]");

      sessionListRef.current = cached;
      setSessions(cached);
    } catch {
      setNotice("Browser storage is unavailable. Sessions will be loaded from the server.");
    }

    void loadAuth();
  }, []);

  useEffect(() => {
    if (!connected) return;
    let active = true;

    // Providers can be slow or unavailable; neither holds up the session list.
    void Promise.all([
      chatgptLogin().catch(() => null),
      anthropicStatus().catch(() => ({ connected: false })),
    ]).then(([status, claude]) => {
      if (!active) return;
      setChatGPT(status?.state === "connected");
      setAnthropic(claude.connected);
    });

    return () => {
      active = false;
    };
  }, [connected]);

  useEffect(() => {
    if (!connected || !sessionsReady || chatgpt === null || startupPrompted.current) return;
    startupPrompted.current = true;

    // Never replace a dialog the user opened while startup was in flight.
    setModal(
      (current) => current ?? (!chatgpt && !anthropic ? "chatgpt" : sessions.length ? null : "new"),
    );
  }, [connected, sessionsReady, chatgpt, anthropic, sessions.length]);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    const { signal } = controller;
    let initial = true;
    let inFlight = false;
    // A change announced mid-request may not be in its answer: fetch once more after it.
    let again = false;

    const refresh = async (startup = false, announced = false) => {
      if (!startup && document.visibilityState === "hidden") return;

      // Focus and timer refreshes coalesce; an announced change must not be lost to one.
      if (inFlight) {
        again ||= announced;

        return;
      }

      inFlight = true;
      const before = sessionListRef.current;

      try {
        const saved = decodeSessions(await request("/sessions", undefined, signal));

        if (signal.aborted) return;
        setSessionError("");

        if (sessionListRef.current === before) {
          save(saved);
        } else if (initial) {
          // Keep local changes made during startup, without hiding sessions only the server knows.
          updateSessions((current) => [
            ...current,
            ...saved.filter((item) => !current.some((local) => local.id === item.id)),
          ]);
        }
      } catch (cause) {
        if (!signal.aborted)
          setSessionError(
            `Could not sync sessions: ${cause instanceof Error ? cause.message : "Server unavailable"}`,
          );
      } finally {
        inFlight = false;

        if (again && !signal.aborted) {
          again = false;
          void refresh();
        }

        if (!signal.aborted && initial) {
          initial = false;

          const recent = sessionList(
            sessionListRef.current.filter(belongsInSidebar),
            "",
            Date.now(),
          );

          setSelected((current) => current || recent.active[0]?.id || "");
          setSessionsReady(true);
        }
      }
    };

    const refreshVisible = () => void refresh();
    void refresh(true);
    // The server announces changes over a socket; polling only covers a socket that died quietly.
    const unwatch = watchSessions(() => void refresh(false, true));
    const timer = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    // Hidden tabs skip announced changes; catch up when shown again.
    document.addEventListener("visibilitychange", refreshVisible);

    return () => {
      controller.abort();
      unwatch();
      document.removeEventListener("visibilitychange", refreshVisible);
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
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
    const current = sessionListRef.current;
    const next = update(current);

    if (next === current) return;

    sessionListRef.current = next;
    setSessions(next);

    try {
      localStorage.setItem(cacheStorageKey, JSON.stringify(next));
    } catch {
      setNotice(
        "Could not cache the session list in this browser. Your sessions are still on the server.",
      );
    }
  }

  // Index the prompts before the window once per session, and again only if a reconnect leaves a gap
  // between what was indexed and what is held. Older pages loading never need it again.
  useEffect(() => {
    if (!connected || before === undefined) return;

    if (railIndex?.session === selected && railIndex.through >= before) return;

    if (indexing.current === selected) return;

    const id = selected;
    const through = before;
    indexing.current = id;

    promptIndex(id, through)
      .then((prompts) => setRailIndex({ session: id, through, marks: indexedMarks(prompts) }))
      // The rail still covers the loaded turns; reopening the session tries again.
      .catch(() => undefined)
      .finally(() => {
        if (indexing.current === id) indexing.current = undefined;
      });
  }, [connected, selected, before, railIndex]);

  /**
   * Fetches the page before the oldest held entry, as the reader scrolls back toward the first prompt, or
   * every page back to `until` (an entry ID), for the rail jumping to a turn not loaded yet.
   */
  async function loadOlder(until?: number) {
    const through = snapshot?.before;

    if (through === undefined || olderThrough === through) return;

    const id = selected;
    setOlderThrough(through);
    setOlderError("");

    try {
      let page = await historyPage(id, through);
      const entries = [...page.entries];

      while (until !== undefined && page.before !== undefined && page.before >= until) {
        page = await historyPage(id, page.before);
        entries.unshift(...page.entries);
      }

      page = page.before === undefined ? { entries } : { entries, before: page.before };

      // Entry IDs are unique per Dolly instance, so a page for another session never matches `before`.
      setSnapshot((held) => (held ? prependHistory(held, through, page) : held));
    } catch (cause) {
      setOlderError(cause instanceof Error ? cause.message : "Could not load earlier messages.");
    } finally {
      setOlderThrough((current) => (current === through ? undefined : current));
    }
  }

  /** Moves the address to `id`'s canonical URL, or the app root when nothing is open. */
  function route(id: string, list: readonly SavedSession[], replace: boolean) {
    if (!id) {
      if (routed || feed) void navigate({ to: "/", replace });

      return;
    }

    const workspace = workspaceOf(list, id);

    if (!feed && routed === id && params.workspaceId === workspace) return;

    void navigate({
      to: "/workspace/$workspaceId/session/$sessionId",
      params: { workspaceId: workspace, sessionId: id },
      replace,
    });
  }

  // Links, reloads and back/forward open the session the URL names.
  useEffect(() => {
    if (!routed) return;
    setSelected(routed);
  }, [routed]);

  // Keeps the address on the open session's canonical URL: a bare /session/<id> link, the root
  // after a session is chosen for you, or a workspace that is not the session's root.
  useEffect(() => {
    // The URL moved first (a link or back/forward); the effect above catches the selection up.
    if (routed && routed !== selected) return;

    // The feed keeps its own URL while a session stays selected behind it.
    if (feed) return;

    if (!selected || !sessions.some((item) => item.id === selected)) return;

    // A workspace link waits for the effect below to open that workspace.
    if (!routed && params.workspaceId && workspaceOf(sessions, selected) !== params.workspaceId)
      return;
    route(selected, sessions, true);
  }, [routed, params.workspaceId, selected, sessions, feed]);

  // A workspace link (/workspace/<id>) opens the session that started it.
  useEffect(() => {
    if (routed || !params.workspaceId) return;
    const main = workspaceMain(sessions, params.workspaceId);

    if (main) setSelected(main.id);
  }, [routed, params.workspaceId, sessions]);

  function openWorkspace(id: string) {
    const main = workspaceMain(sessions, id);

    if (main) select(main.id);
  }

  function select(id: string, list = sessions) {
    setSelected(id);
    route(id, list, false);
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

    if (!target.archived && selected === id) selectAfterArchive([id]);
  }

  /** After archiving the open session, stay in its workspace if any of it is left. */
  function selectAfterArchive(archived: readonly string[]) {
    const left = sessions.filter((item) => !archived.includes(item.id));

    // Like the global fallback, never land on an automatic review.
    const sibling = workspaceTabs(left, workspaceOf(sessions, selected)).find(
      (item) => !item.archived && !automated(item),
    );

    select(
      sibling?.id || sessionList(left.filter(belongsInSidebar), "", Date.now()).active[0]?.id || "",
    );
  }

  /** Archives every session in a workspace, or restores them all. */
  async function toggleArchiveWorkspace(id: string) {
    const row = sidebarRows.find((item) => item.id === id);

    if (!row) return;
    const archived = !row.archived;
    const changed = row.sessions.filter((item) => Boolean(item.archived) !== archived);

    try {
      await Promise.all(
        changed.map((item) =>
          request(`/sessions/${encodeURIComponent(item.id)}`, { archived }, undefined, "PUT"),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sync archive state.");

      return;
    }

    const ids = changed.map((item) => item.id);
    updateSessions((current) =>
      current.map((item) => (ids.includes(item.id) ? { ...item, archived } : item)),
    );

    if (archived && workspaceOf(sessions, selected) === id)
      selectAfterArchive(row.sessions.map((item) => item.id));
  }

  /** Keeping a spawned session makes it a tab of its workspace. */
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

  // What new sessions start with; also what "Reset to default" returns a session to.
  useEffect(() => {
    if (chatgpt === null) return;
    let active = true;
    defaultModel().then(
      (value) => {
        if (active) setDefaults(value);
      },
      () => {},
    );

    return () => {
      active = false;
    };
  }, [chatgpt, anthropic]);

  /** Changes the open session's model settings; they apply from the next model request. */
  async function configure(settings: SessionChange) {
    const id = selected;
    const previous = sessions.find((item) => item.id === id);

    if (!previous) return;

    const apply = (value: Partial<SavedSession>) =>
      updateSessions((current) =>
        current.map((item) => (item.id === id ? { ...item, ...value } : item)),
      );

    apply(settings);

    try {
      await request(`/sessions/${encodeURIComponent(id)}/settings`, settings, undefined, "PUT");
    } catch (cause) {
      apply({
        model: previous.model,
        thinkingLevel: previous.thinkingLevel,
        speed: previous.speed,
        autoFallback: previous.autoFallback,
      });
      setError(
        cause instanceof Error
          ? cause.message
          : "model" in settings
            ? "Could not change the model."
            : "Could not change the model settings.",
      );
    }
  }

  /** Makes the open session's model settings the defaults for new sessions. */
  async function saveDefaults(settings: Required<SessionChange>) {
    try {
      setDefaults(await defaultModel(settings));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the defaults.");
    }
  }

  /** The composer's model pill for the open session, with its defaults actions. */
  function sessionModelControl(current: SavedSession) {
    const settings = {
      model: current.model,
      thinkingLevel: current.thinkingLevel ?? DEFAULT_EFFORT,
      speed: current.speed ?? "standard",
      autoFallback: current.autoFallback ?? defaults?.autoFallback ?? true,
    } as const;

    const atDefault =
      defaults !== null &&
      settings.model === defaults.effective &&
      settings.thinkingLevel === defaults.thinkingLevel &&
      settings.speed === defaults.speed &&
      settings.autoFallback === defaults.autoFallback;

    return (
      <ModelControl
        model={settings.model}
        effort={settings.thinkingLevel}
        speed={settings.speed}
        autoFallback={settings.autoFallback}
        placement="above"
        isDefault={atDefault}
        atDefault={atDefault}
        onModel={(model) => {
          // Keep the effort where the new model accepts it, as the server does.
          const level = normalizeEffort(model, settings.thinkingLevel);

          void configure(
            level === settings.thinkingLevel ? { model } : { model, thinkingLevel: level },
          );
        }}
        ultrafastAvailable={defaults?.ultrafastAvailable ?? false}
        onEffort={(thinkingLevel) => void configure({ thinkingLevel })}
        onSpeed={(speed) => void configure({ speed })}
        onAutoFallback={(autoFallback) => void configure({ autoFallback })}
        onSetDefault={() => void saveDefaults(settings)}
        onReset={
          defaults
            ? () =>
                void configure({
                  model: defaults.effective,
                  thinkingLevel: defaults.thinkingLevel,
                  speed: defaults.speed,
                  autoFallback: defaults.autoFallback,
                })
            : undefined
        }
      />
    );
  }

  /** Starts a session in a new workspace, or in `workspace` when given. */
  function newSession(workspace?: string) {
    setMobileOpen(false);
    setJoining(workspace);
    setModal(chatgpt === false && !anthropic ? "chatgpt" : "new");
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
        selected={workspace}
        connected={connected}
        open={mobileOpen}
        feed={feed}
        onSelect={openWorkspace}
        onArchive={(id) => void toggleArchiveWorkspace(id)}
        onNew={() => newSession()}
        onSettings={() => {
          setMobileOpen(false);
          void navigate({ to: "/settings" });
        }}
        onClose={() => setMobileOpen(false)}
        onFeed={() => setMobileOpen(false)}
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
                label={session.kept ? "Remove workspace tab" : "Keep as workspace tab"}
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
            <IconButton label="New session" onClick={() => newSession()}>
              <PlusIcon />
            </IconButton>
            {session && !feed && <SessionSummaryToggle summary={summary} />}
          </div>
        </header>
        <div className="content-layout">
          <div className="conversation-panel">
            {session && !feed && workspace && (
              <nav className="workspace-tabs" aria-label="Workspace sessions">
                {tabs.map((tab) => {
                  // A spawned session open in the workspace lights the tab it was spawned from.
                  const active =
                    tab.id === session.id ||
                    (!tabs.some((item) => item.id === session.id) &&
                      tab.id === rootSession(rows, session.id));

                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={`workspace-tab ${active ? "active" : ""} ${tab.archived ? "archived" : ""}`}
                      aria-current={active ? "page" : undefined}
                      title={tab.archived ? `${tab.title} (archived)` : tab.title}
                      onClick={() => select(tab.id)}
                    >
                      {tab.running && (
                        <span className="status-dot working pulse" aria-hidden="true" />
                      )}
                      <span>{tab.title}</span>
                    </button>
                  );
                })}
                <IconButton
                  label="New session in this workspace"
                  className="workspace-tab-new"
                  onClick={() => newSession(workspace)}
                >
                  <PlusIcon />
                </IconButton>
              </nav>
            )}
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
                    load: (until) => void loadOlder(until),
                    index: railIndex?.session === session.id ? railIndex.marks : undefined,
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
                  activity={snapshot?.entries.at(-1)?.id ?? 0}
                  modelControl={sessionModelControl(session)}
                />
              </>
            ) : (
              <GetStarted
                // An unknown model state (still loading, or unreadable) does not nag.
                modelConnected={chatgpt !== false || anthropic}
                installUrl={auth.github.connected ? auth.github.installUrl : ""}
                settingsUrl={auth.github.connected ? auth.github.settingsUrl : ""}
                onConnectModel={() => setModal("chatgpt")}
                onNewSession={() => newSession()}
                fallback={
                  <div className="empty-state">
                    <span className="brand-mark large" aria-hidden="true">
                      D
                    </span>
                    <h2>
                      {chatgpt === false && !anthropic
                        ? "Connect a model"
                        : "No workspace selected"}
                    </h2>
                    <button type="button" className="primary-button" onClick={() => newSession()}>
                      {chatgpt === false && !anthropic ? "Connect a model" : "New session"}
                    </button>
                  </div>
                }
              />
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
      {modal === "chatgpt" && (
        <Modal title="Connect a model" onClose={() => setModal(null)}>
          <h3>ChatGPT subscription</h3>
          <ChatGPTLogin
            onConnected={() => {
              setChatGPT(true);
              setModal(sessions.length ? null : "new");
            }}
            onCancel={() => {
              setChatGPT(false);
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
          workspace={
            joining
              ? {
                  id: joining,
                  title: sidebarRows.find((row) => row.id === joining)?.title ?? "",
                }
              : undefined
          }
          onClose={() => setModal(null)}
          onImport={() => setModal("import")}
          onSaved={(value) => save([value, ...sessions.filter((item) => item.id !== value.id)])}
          onCreated={(value) => {
            const next = [value, ...sessions.filter((item) => item.id !== value.id)];
            save(next);
            select(value.id, next);
            setModal(null);
          }}
        />
      )}
      {modal === "import" && (
        <SessionModal
          onClose={() => setModal(null)}
          onNew={() => setModal("new")}
          onCreated={(value) => {
            const next = [value, ...sessions.filter((item) => item.id !== value.id)];
            save(next);
            select(value.id, next);
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
