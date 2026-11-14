import { useState, type SVGProps } from "react";
import { ChevronDownIcon, XMarkIcon } from "@heroicons/react/16/solid";
import {
  ArchiveBoxIcon,
  CodeBracketIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SignalIcon,
} from "@heroicons/react/24/outline";
import { ago } from "../lib/time";
import { sessionList } from "../lib/session-list";
import { IconButton, Input, RepoBadge } from "./ui";
import type { SavedSession } from "../lib/api";

export type WorkspaceRow = {
  id: string;
  title: string;
  repository: string;
  updatedAt: number;
  running: boolean;
  archived?: boolean;
  pullRequest?: SavedSession["pullRequest"];
};

const PULL_LABELS = {
  open: "Pull request open",
  draft: "Draft pull request",
  merged: "Pull request merged",
  closed: "Pull request closed",
} as const;

/** One status glyph per row: activity wins, then pull request state, then plain branch. */
function RowStatus({ row }: { row: WorkspaceRow }) {
  if (row.running) return <span className="status-dot working pulse" aria-label="Agent working" />;

  const pull = row.pullRequest;

  if (pull) {
    const state = pull.state ?? "open";

    return (
      <PullRequestIcon
        className={`workspace-icon pr-${state}`}
        aria-label={`${PULL_LABELS[state]} #${pull.number}`}
      />
    );
  }

  return row.repository ? (
    <BranchIcon className="workspace-icon branch" aria-label="No pull request" />
  ) : (
    <CodeBracketIcon className="workspace-icon branch" aria-label="No repository" />
  );
}

function PullRequestIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" role="img" {...props}>
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" role="img" {...props}>
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

export function Sidebar({
  rows,
  selected,
  connected,
  open,
  feed,
  onSelect,
  onArchive,
  onNew,
  onSettings,
  onClose,
  onFeed,
}: {
  rows: readonly WorkspaceRow[];
  selected: string;
  connected: boolean;
  open: boolean;
  feed: boolean;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  onClose: () => void;
  onFeed: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const now = Date.now();
  const lists = sessionList(rows, selected, now);

  const visible = archived
    ? lists.archived
    : showOlder || query.trim()
      ? lists.active
      : lists.recent;

  const filtered = visible.filter((row) =>
    `${row.title} ${row.repository}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      {open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={onClose}
        />
      )}
      <aside
        id="workspace-navigation"
        className={`sidebar ${open ? "sidebar-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <div className="sidebar-top">
          <button
            type="button"
            className="account-switch"
            onClick={onSettings}
            aria-label="Settings"
          >
            <span className="brand-mark" aria-hidden="true">
              D
              <span className={`brand-presence ${connected ? "online" : ""}`} />
            </span>
            <span className="account-name">dolly</span>
            <ChevronDownIcon />
          </button>
          <IconButton label="Close navigation" className="mobile-only" onClick={onClose}>
            <XMarkIcon />
          </IconButton>
        </div>
        <button
          type="button"
          className={`nav-row ${feed ? "active" : ""}`}
          aria-current={feed ? "page" : undefined}
          onClick={onFeed}
        >
          <SignalIcon />
          <span>Feed</span>
        </button>
        <div className="sidebar-heading">
          <h2>Workspaces</h2>
          <IconButton
            label="Search workspaces"
            aria-pressed={searching}
            onClick={() => {
              setSearching(!searching);
              setQuery("");
            }}
          >
            <MagnifyingGlassIcon />
          </IconButton>
          <IconButton label="New session" onClick={onNew}>
            <PlusIcon />
          </IconButton>
        </div>
        {searching && (
          <Input
            type="search"
            name="search"
            className="sidebar-search"
            aria-label="Search workspaces"
            placeholder="Search"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
          />
        )}
        {rows.length > 0 && (
          <p className="sidebar-group">
            {archived ? "Archived" : "Recent"} <span>{filtered.length}</span>
          </p>
        )}
        <nav className="workspace-list" aria-label="Workspaces">
          {filtered.map((row) => {
            const active = selected === row.id && !feed;

            return (
              <div key={row.id} className="workspace-item">
                <button
                  type="button"
                  className={`workspace-row ${active ? "active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelect(row.id)}
                >
                  <RowStatus row={row} />
                  <RepoBadge repository={row.repository} />
                  <span className="workspace-title">{row.title}</span>
                  <span className="workspace-time">{ago(row.updatedAt, now)}</span>
                </button>
                {!row.archived && (
                  <IconButton
                    label={`Archive session: ${row.title}`}
                    className="workspace-archive"
                    onClick={() => onArchive(row.id)}
                  >
                    <ArchiveBoxIcon />
                  </IconButton>
                )}
              </div>
            );
          })}
          {query && filtered.length === 0 && (
            <p className="sidebar-empty">No matching workspaces.</p>
          )}
          {connected && rows.length === 0 && <p className="sidebar-empty">No workspaces yet.</p>}
          {archived && !query && filtered.length === 0 && (
            <p className="sidebar-empty">No archived sessions.</p>
          )}
        </nav>
        {!archived && lists.older > 0 && !query.trim() && (
          <button type="button" className="nav-row" onClick={() => setShowOlder(!showOlder)}>
            {showOlder ? "Hide older" : `Show older (${lists.older})`}
          </button>
        )}
        <button
          type="button"
          className={`nav-row ${archived ? "active" : ""}`}
          aria-pressed={archived}
          onClick={() => setArchived(!archived)}
        >
          {archived ? "Back to recent" : `Archived sessions (${lists.archived.length})`}
        </button>
      </aside>
    </>
  );
}
