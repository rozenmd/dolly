import { useState } from "react";
import {
  BoltIcon,
  ChevronDownIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  QueueListIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import { IconButton, Input } from "./ui";

export type WorkspaceRow = {
  id: string;
  title: string;
  repository: string;
  status: string;
  time: string;
};

export function Sidebar({
  rows,
  selected,
  connected,
  open,
  onSelect,
  onNew,
  onSettings,
  onClose,
  onFeed,
  feed,
}: {
  rows: readonly WorkspaceRow[];
  selected: string;
  connected: boolean;
  open: boolean;
  feed: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSettings: () => void;
  onClose: () => void;
  onFeed: () => void;
}) {
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);

  const filtered = rows.filter(
    (row) =>
      row.title.toLowerCase().includes(query.toLowerCase()) &&
      (!working || row.status === "Working"),
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
        <div className="brand-row">
          <a href="/" aria-label="pi-hard homepage" className="brand">
            <span className="brand-mark">π</span>
            <span>
              pi-hard<span className="brand-dot">.</span>
            </span>
          </a>
          <IconButton label="Close navigation" className="mobile-only" onClick={onClose}>
            <XMarkIcon />
          </IconButton>
          <span className="personal-label">
            Personal
            <ChevronDownIcon />
          </span>
        </div>
        <button type="button" className={`nav-row ${feed ? "active" : ""}`} onClick={onFeed}>
          <QueueListIcon />
          <span>Activity feed</span>
          <span className="keycap">G F</span>
        </button>
        <div className="sidebar-section-heading">
          <h2>Workspaces</h2>
          <IconButton label="New workspace" onClick={onNew}>
            <PlusIcon />
          </IconButton>
        </div>
        <div className="search-field">
          <MagnifyingGlassIcon />
          <Input
            type="search"
            name="search"
            aria-label="Search workspaces"
            placeholder="Find a workspace…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="workspace-filter">
          <button type="button" onClick={() => setWorking(!working)} aria-pressed={working}>
            {working ? "Working" : "All workspaces"}
            <ChevronDownIcon />
          </button>
          <span>{filtered.length}</span>
        </div>
        <nav className="workspace-list" aria-label="Workspaces">
          {filtered.map((row) => (
            <button
              type="button"
              key={row.id}
              className={`workspace-row ${selected === row.id && !feed ? "active" : ""}`}
              aria-current={selected === row.id && !feed ? "page" : undefined}
              onClick={() => onSelect(row.id)}
            >
              <span
                className={`workspace-state state-${row.status.toLowerCase()}`}
                title={row.status}
              >
                {row.status === "Working" || row.status === "Unread" ? (
                  <span className="status-dot" />
                ) : (
                  <CodeBracketIcon />
                )}
              </span>
              <span className="workspace-label">
                <span>{row.title}</span>
                <span className="workspace-repo">{row.repository}</span>
              </span>
              <span className="workspace-time">{row.time}</span>
              <span className="sr-only">{row.status}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="empty-search">
              {query ? "No matching workspaces." : "No workspaces here yet."}
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="runtime-note">
            <CommandLineIcon />
            <div>
              <strong>Your code. Your agent.</strong>
              <p>Durable by design.</p>
            </div>
          </div>
          <button type="button" className="account-row" onClick={onSettings}>
            <span className="account-avatar">Y</span>
            <span>
              <strong>Your workspace</strong>
              <span className="connection-caption">
                {connected ? "API connected" : "Preview mode"}
              </span>
            </span>
            <Cog6ToothIcon />
          </button>
        </div>
        <div className="sidebar-footnote">
          <BoltIcon /> Powered by Pi Durable
        </div>
      </aside>
    </>
  );
}
