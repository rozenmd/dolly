import { useState, type SVGProps } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, XMarkIcon } from "@heroicons/react/16/solid";
import {
  ArchiveBoxIcon,
  BoltIcon,
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
  /** When the workspace was pinned to the top of the sidebar; absent if it isn't. */
  pinnedAt?: number;
  pullRequest?: SavedSession["pullRequest"];
  /** The automation whose run started this workspace. */
  automationRun?: string;
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

export function PullRequestIcon(props: SVGProps<SVGSVGElement>) {
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

/** A pushpin, in the 24px outline style of the Heroicons beside it; `off` strikes it through. */
export function PinIcon({ off = false, ...props }: SVGProps<SVGSVGElement> & { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M8.25 3.75h7.5M9.75 3.75v5.5l-3 3.5v1.5h10.5v-1.5l-3-3.5v-5.5M12 14.25v6" />
      {off && <path d="m3.75 3.75 16.5 16.5" />}
    </svg>
  );
}

function SidebarRow({
  row,
  active,
  now,
  onSelect,
  onArchive,
  onPin,
}: {
  row: WorkspaceRow;
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onPin: (id: string) => void;
}) {
  const pinned = Boolean(row.pinnedAt);

  return (
    <div className="workspace-item">
      <button
        type="button"
        className={`workspace-row ${active ? "active" : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(row.id)}
      >
        <RowStatus row={row} />
        <RepoBadge repository={row.repository} />
        <span className="workspace-title">{row.title}</span>
        {row.automationRun && (
          <span
            className="workspace-automation"
            role="img"
            aria-label={`Started by automation ${row.automationRun}`}
            title={`Started by automation ${row.automationRun}`}
          >
            <BoltIcon />
          </span>
        )}
        <span className="workspace-time">{ago(row.updatedAt, now)}</span>
      </button>
      {!row.archived && (
        <div className="workspace-actions">
          <IconButton
            label={`${pinned ? "Unpin" : "Pin"} workspace: ${row.title}`}
            aria-pressed={pinned}
            className="workspace-pin"
            onClick={() => onPin(row.id)}
          >
            <PinIcon off={pinned} />
          </IconButton>
          <IconButton
            label={`Archive workspace: ${row.title}`}
            className="workspace-archive"
            onClick={() => onArchive(row.id)}
          >
            <ArchiveBoxIcon />
          </IconButton>
        </div>
      )}
    </div>
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
  onPin,
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
  onPin: (id: string) => void;
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
      ? lists.unpinned
      : lists.recent;

  const matches = (row: WorkspaceRow) =>
    `${row.title} ${row.repository}`.toLowerCase().includes(query.trim().toLowerCase());

  const filtered = visible.filter(matches);
  const pinned = archived ? [] : lists.pinned.filter(matches);

  const item = (row: WorkspaceRow) => (
    <SidebarRow
      key={row.id}
      row={row}
      active={selected === row.id && !feed}
      now={now}
      onSelect={onSelect}
      onArchive={onArchive}
      onPin={onPin}
    />
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
        <Link
          to="/feed"
          className={`nav-row ${feed ? "active" : ""}`}
          aria-current={feed ? "page" : undefined}
          onClick={onFeed}
        >
          <SignalIcon />
          <span>Feed</span>
        </Link>
        <Link to="/settings/automations" className="nav-row">
          <BoltIcon />
          <span>Automations</span>
        </Link>
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
        {pinned.length > 0 && (
          <>
            <p className="sidebar-group">
              Pinned <span>{pinned.length}</span>
            </p>
            <nav className="workspace-list" aria-label="Pinned workspaces">
              {pinned.map(item)}
            </nav>
          </>
        )}
        {rows.length > 0 && (archived || filtered.length > 0 || pinned.length === 0) && (
          <p className="sidebar-group">
            {archived ? "Archived" : "Recent"} <span>{filtered.length}</span>
          </p>
        )}
        <nav className="workspace-list" aria-label="Workspaces">
          {filtered.map(item)}
          {query && filtered.length === 0 && pinned.length === 0 && (
            <p className="sidebar-empty">No matching workspaces.</p>
          )}
          {connected && rows.length === 0 && <p className="sidebar-empty">No workspaces yet.</p>}
          {archived && !query && filtered.length === 0 && (
            <p className="sidebar-empty">No archived workspaces.</p>
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
          {archived ? "Back to recent" : `Archived workspaces (${lists.archived.length})`}
        </button>
      </aside>
    </>
  );
}
