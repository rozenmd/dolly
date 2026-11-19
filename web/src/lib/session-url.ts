/**
 * Session URLs, after opensession (frontend/lib/share-link.ts): a session lives at
 * `/workspace/<workspaceId>/session/<sessionId>`. Dolly has no separate workspace
 * record, so a session's workspace is its root session, the one its threads hang off.
 */

import { rootSession } from "./session-threads";

type Related = { id: string; parentId?: string };

/** The workspace a session belongs to: its root session's ID. */
export function workspaceId(sessions: readonly Related[], id: string) {
  return rootSession(sessions, id);
}

/** Canonical path for a session, or the app root when none is open. */
export function sessionPath(sessions: readonly Related[], id: string) {
  if (!id) return "/";

  return `/workspace/${encodeURIComponent(workspaceId(sessions, id))}/session/${encodeURIComponent(id)}`;
}
