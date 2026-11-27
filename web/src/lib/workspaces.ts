/**
 * Workspaces group the sessions about one piece of work. Each one is a sidebar row, its
 * sessions are tabs in it, and a session's URL is `/workspace/<workspaceId>/session/<id>`.
 */

type Member = {
  id: string;
  parentId?: string;
  workspaceId?: string;
  kept?: boolean;
  /** The chief of staff: the sessions it spawns start workspaces of their own. */
  chief?: boolean;
  /** Set for automatic reviews (lib/session-threads); they never represent a workspace with work in it. */
  automation?: "review";
  createdAt?: number;
  updatedAt: number;
};

/**
 * The workspace a session belongs to. Spawned sessions belong to their root's; a session
 * the server has not described yet (just created) is its own until it is. The chief of staff
 * has no repository to work in, so a session it spawns is a root of its own workspace, in the
 * sidebar like any other, and only its breadcrumb leads back to the chief.
 */
export function workspaceOf(sessions: readonly Member[], id: string) {
  return workspaceIndex(sessions).get(id) ?? id;
}

/** Whether `session` was spawned by the chief of staff, and so starts its own workspace. */
export function spawnedByChief(sessions: readonly Member[], session: Member) {
  return Boolean(session.parentId && chiefIds(sessions).has(session.parentId));
}

// Each list is indexed once, so grouping a long session list stays linear.
const indexes = new WeakMap<readonly Member[], Map<string, string>>();
const chiefs = new WeakMap<readonly Member[], Set<string>>();

function chiefIds(sessions: readonly Member[]) {
  let ids = chiefs.get(sessions);

  if (!ids) {
    ids = new Set(sessions.flatMap((session) => (session.chief ? [session.id] : [])));
    chiefs.set(sessions, ids);
  }

  return ids;
}

function workspaceIndex(sessions: readonly Member[]) {
  let index = indexes.get(sessions);

  if (index) return index;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const chief = chiefIds(sessions);
  index = new Map();

  for (const session of sessions) {
    let root = session;
    const seen = new Set([session.id]);

    while (root.parentId && !chief.has(root.parentId) && !seen.has(root.parentId)) {
      const parent = byId.get(root.parentId);

      if (!parent) break;
      seen.add(parent.id);
      root = parent;
    }

    // A chief-spawned root keys its own workspace, even from a server that put it in the chief's.
    const chiefWorkspace =
      root.parentId && chief.has(root.parentId)
        ? (byId.get(root.parentId)?.workspaceId ?? root.parentId)
        : undefined;

    index.set(
      session.id,
      root.workspaceId && root.workspaceId !== chiefWorkspace ? root.workspaceId : root.id,
    );
  }

  indexes.set(sessions, index);

  return index;
}

/**
 * Spawned sessions stay with their parent unless the owner kept one as a tab, or the chief of
 * staff spawned it: that one starts its own workspace.
 */
const tabbed = (sessions: readonly Member[], session: Member) =>
  !session.parentId || Boolean(session.kept) || spawnedByChief(sessions, session);

/**
 * The sessions a workspace shows as tabs: the one the chief of staff spawned, if it started the
 * workspace, then its own oldest first, then the spawned ones kept, and automatic reviews last, so work started in a review's workspace names and opens its row.
 */
export function workspaceTabs<T extends Member>(sessions: readonly T[], workspaceId: string) {
  const age = (session: Member) => session.createdAt ?? session.updatedAt;

  return sessions
    .filter(
      (session) => tabbed(sessions, session) && workspaceOf(sessions, session.id) === workspaceId,
    )
    .sort(
      (a, b) =>
        Number(Boolean(a.automation)) - Number(Boolean(b.automation)) ||
        // The session the chief spawned started the workspace, however recently it was prompted.
        Number(!spawnedByChief(sessions, a)) - Number(!spawnedByChief(sessions, b)) ||
        Number(Boolean(a.parentId) && !spawnedByChief(sessions, a)) -
          Number(Boolean(b.parentId) && !spawnedByChief(sessions, b)) ||
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

/** The chief of staff that spawned a workspace's first session, for the row's marker. */
function chiefOf<T extends Row>(sessions: readonly T[], main: T) {
  return spawnedByChief(sessions, main)
    ? sessions.find((session) => session.id === main.parentId)
    : undefined;
}

/**
 * One sidebar row per workspace, named after the session that started it. It is as recent as
 * its latest tab, busy while any of its sessions is, and archived only when all its tabs are
 * (automatic reviews aside, once other work was started in the workspace). It is pinned while
 * any of its tabs is, from the earliest pin. A workspace the chief of staff started says so in
 * `from`, its name.
 */
export function workspaceRows<T extends Row>(sessions: readonly T[]) {
  const ids = new Set(
    sessions.flatMap((session) =>
      tabbed(sessions, session) ? [workspaceOf(sessions, session.id)] : [],
    ),
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
    const chief = chiefOf(sessions, main);

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
        ...(chief && { from: chief.title }),
      },
    ];
  });
}
