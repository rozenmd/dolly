/**
 * A session's threads: the sessions it spawned, and theirs in turn. They belong to
 * their root's workspace (lib/workspaces.ts).
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Related = {
  id: string;
  parentId?: string;
  kept?: boolean;
  automation?: "review";
  /** The chief of staff: the sessions it spawns are workspaces of their own (lib/workspaces.ts). */
  chief?: boolean;
};

type Thread = Related & {
  updatedAt: number;
  running?: boolean;
  pullRequest?: { number: number; state?: "open" | "draft" | "merged" | "closed" };
};

/** Where a thread stands, in the order the panel lists them. */
export type ThreadState = "ready" | "working" | "idle" | "shipped";

export const THREAD_STATE_ORDER: readonly ThreadState[] = ["ready", "working", "idle", "shipped"];

export const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  ready: "Ready to ship",
  working: "Working",
  idle: "Idle",
  shipped: "Shipped",
};

/**
 * The sessions the sidebar lists. Spawned sessions are not workspace tabs unless the owner kept
 * one, or the chief of staff spawned it: that one starts a workspace of its own. The others are
 * reached from their parent instead.
 */
export function sidebarSessions<T extends Related>(sessions: readonly T[]): T[] {
  const chiefs = new Set(sessions.flatMap((session) => (session.chief ? [session.id] : [])));

  return sessions.filter(
    (session) =>
      !automated(session) &&
      (!session.parentId || Boolean(session.kept) || chiefs.has(session.parentId)),
  );
}

/**
 * Sessions an automation started, such as automatic pull request reviews, stay out of the
 * sidebar, after OpenSession: they are opened from their GitHub links or by URL instead. The
 * open one keeps its row while it is open, and a workspace keeps its row once writable work is
 * started in it.
 */
export function automated(session: Pick<Related, "automation">) {
  return session.automation !== undefined;
}

/**
 * The highest known ancestor of `id`, following parent edges; `id` itself for a root. A session
 * the chief of staff spawned is a root, like its workspace (lib/workspaces.ts).
 */
export function rootSession(sessions: readonly Related[], id: string) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set([id]);
  let root = byId.get(id);

  while (root?.parentId && !seen.has(root.parentId)) {
    const parent = byId.get(root.parentId);

    if (!parent || parent.chief) break;
    seen.add(parent.id);
    root = parent;
  }

  return root?.id ?? id;
}

/** The sessions `rootId` started, and theirs in turn, newest first. */
export function sessionThreads<T extends Thread>(sessions: readonly T[], rootId: string): T[] {
  const inside = new Set([rootId]);
  const out: T[] = [];
  let grew = true;

  while (grew) {
    grew = false;

    for (const session of sessions)
      if (session.parentId && inside.has(session.parentId) && !inside.has(session.id)) {
        inside.add(session.id);
        out.push(session);
        grew = true;
      }
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function threadState(session: Thread): ThreadState {
  const pull = session.pullRequest;

  if (pull?.state === "merged") return "shipped";

  if (session.running) return "working";

  if (pull && (pull.state ?? "open") === "open") return "ready";

  return "idle";
}

/** One short line saying where a thread is, from what the session list carries. */
export function threadStatusLine(session: Thread): string {
  const pull = session.pullRequest;
  const pr = pull ? `#${pull.number}` : "PR";

  switch (threadState(session)) {
    case "shipped":
      return `Merged ${pr}`;
    case "working":
      return "Working";
    case "ready":
      return `${pr} open`;
    case "idle":
      if (pull?.state === "draft") return `Draft ${pr}`;

      if (pull?.state === "closed") return `${pr} closed`;

      return "Idle";
  }
}

/** Threads by state in panel order; empty groups left out. */
export function groupThreads<T extends Thread>(threads: readonly T[]) {
  return THREAD_STATE_ORDER.flatMap((state) => {
    const inState = threads.filter((thread) => threadState(thread) === state);

    return inState.length ? [{ state, threads: inState }] : [];
  });
}

const Spawned = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));

const SPAWNED = /^Spawned task `([^`]+)`/;

/**
 * The child a finished spawn_task call started, read from its result: "Spawned task `<id>` — …",
 * or the JSON `{id}` that sessions recorded before.
 */
export function spawnedThreadId(name: string, status: string, output: string): string | null {
  if (name !== "spawn_task" || status !== "done") return null;

  return (
    SPAWNED.exec(output)?.[1] ??
    Option.getOrNull(Schema.decodeUnknownOption(Spawned)(output))?.id ??
    null
  );
}

/** The first sentence of a thread's latest reply, as plain text, for the line under its title. */
export function replyGist(markdown: string, max = 96): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}
