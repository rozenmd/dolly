import { useState } from "react";
import { ChevronDownIcon, XMarkIcon } from "@heroicons/react/16/solid";
import {
  CodeBracketIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SignalIcon,
} from "@heroicons/react/24/outline";
import { ago } from "../lib/time";
import { IconButton, Input, RepoBadge } from "./ui";

export type WorkspaceRow = {
  id: string;
  title: string;
  repository: string;
  updatedAt: number;
  running: boolean;
};

export function Sidebar({
  rows,
  selected,
  connected,
  open,
  feed,
  onSelect,
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
  onNew: () => void;
  onSettings: () => void;
  onClose: () => void;
  onFeed: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const now = Date.now();

  const filtered = rows.filter((row) =>
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
            Recent <span>{filtered.length}</span>
          </p>
        )}
        <nav className="workspace-list" aria-label="Workspaces">
          {filtered.map((row) => {
            const active = selected === row.id && !feed;

            return (
              <button
                type="button"
                key={row.id}
                className={`workspace-row ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(row.id)}
              >
                {row.running ? (
                  <span className="status-dot working" aria-label="Working" />
                ) : (
                  <CodeBracketIcon className="workspace-icon" />
                )}
                <RepoBadge repository={row.repository} />
                <span className="workspace-title">{row.title}</span>
                <span className="workspace-time">{ago(row.updatedAt, now)}</span>
              </button>
            );
          })}
          {query && filtered.length === 0 && (
            <p className="sidebar-empty">No matching workspaces.</p>
          )}
          {connected && rows.length === 0 && <p className="sidebar-empty">No workspaces yet.</p>}
        </nav>
      </aside>
    </>
  );
}
