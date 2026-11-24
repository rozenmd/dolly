/**
 * Workspaces group the sessions about one piece of work. Each one is a sidebar row, its
 * sessions are tabs in it, and a session's URL is `/workspace/<workspaceId>/session/<id>`.
 */

type Member = {
  id: string;
  parentId?: string;
  workspaceId?: string;
  kept?: boolean;
  /** Set for automatic reviews (lib/session-threads); they never represent a workspace with work in it. */
  automation?: "review";
  createdAt?: number;
  updatedAt: number;
};

/**
 * The workspace a session belongs to. Spawned sessions belong to their root's; a session
 * the server has not described yet (just created) is its own until it is.
 */
export function workspaceOf(sessions: readonly Member[], id: string) {
  return workspaceIndex(sessions).get(id) ?? id;
}

// Each list is indexed once, so grouping a long session list stays linear.
const indexes = new WeakMap<readonly Member[], Map<string, string>>();

function workspaceIndex(sessions: readonly Member[]) {
  let index = indexes.get(sessions);

  if (index) return index;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  index = new Map();

  for (const session of sessions) {
    let root = session;
    const seen = new Set([session.id]);

    while (root.parentId && !seen.has(root.parentId)) {
      const parent = byId.get(root.parentId);

      if (!parent) break;
      seen.add(parent.id);
      root = parent;
    }

    index.set(session.id, root.workspaceId ?? root.id);
  }

  indexes.set(sessions, index);

  return index;
}

/** Spawned sessions stay with their parent unless the owner kept one as a tab. */
const tabbed = (session: Member) => !session.parentId || Boolean(session.kept);

/**
 * The sessions a workspace shows as tabs: its own oldest first, then the spawned ones kept, and
 * automatic reviews last, so work started in a review's workspace names and opens its row.
 */
export function workspaceTabs<T extends Member>(sessions: readonly T[], workspaceId: string) {
  const age = (session: Member) => session.createdAt ?? session.updatedAt;

  return sessions
    .filter((session) => tabbed(session) && workspaceOf(sessions, session.id) === workspaceId)
    .sort(
      (a, b) =>
        Number(Boolean(a.automation)) - Number(Boolean(b.automation)) ||
        Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)) ||
        age(a) - age(b) ||
        a.id.localeCompare(b.id),
    );
}

/** The session a workspace opens on: the one that started it. */
export function workspaceMain<T extends Member>(sessions: readonly T[], workspaceId: string) {
  return workspaceTabs(sessions, workspaceId)[0];
}

type Row = Member & {
  title: string;
  repository: string;
  archived?: boolean;
  pinnedAt?: number;
  running?: boolean;
  pullRequest?: unknown;
};

/**
 * One sidebar row per workspace, named after the session that started it. It is as recent as
 * its latest tab, busy while any of its sessions is, and archived only when all its tabs are
 * (automatic reviews aside, once other work was started in the workspace). It is pinned while
 * any of its tabs is, from the earliest pin.
 */
export function workspaceRows<T extends Row>(sessions: readonly T[]) {
  const ids = new Set(
    sessions.flatMap((session) => (tabbed(session) ? [workspaceOf(sessions, session.id)] : [])),
  );

  return [...ids].flatMap((id) => {
    const tabs = workspaceTabs(sessions, id);
    const main = workspaceMain(sessions, id);

    if (!main) return [];
    const members = sessions.filter((session) => workspaceOf(sessions, session.id) === id);

    // Work started in a review's workspace decides whether it is archived; the review can't.
    const work = tabs.some((session) => !session.automation)
      ? tabs.filter((session) => !session.automation)
      : tabs;

    const live = work.filter((session) => !session.archived);
    const newest = [...members].sort((a, b) => b.updatedAt - a.updatedAt);
    // Like the session list, only prompts to its own sessions move a workspace up.
    const updatedAt = Math.max(...tabs.map((session) => session.updatedAt));
    const pins = tabs.flatMap((session) => (session.pinnedAt ? [session.pinnedAt] : []));

    return [
      {
        ...main,
        id,
        main: main.id,
        sessions: tabs,
        updatedAt,
        archived: live.length === 0,
        ...(pins.length > 0 && { pinnedAt: Math.min(...pins) }),
        running: members.some((session) => session.running),
        pullRequest: newest.find((session) => session.pullRequest)?.pullRequest,
      },
    ];
  });
}
