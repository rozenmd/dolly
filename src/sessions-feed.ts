import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type ConversationId,
  type Harness,
  type TaskGraph,
} from "@earendil-works/pi-durable";
import { exceptionDetails } from "./diagnostics";
import { liveStepKey, sessionActivity } from "./session-activity";

/** Hibernation tag for sidebar sockets, apart from the per-session transcript streams. */
const TAG = "sessions";

/** The only message a sidebar socket gets: refetch `/api/sessions`. It never carries session data. */
export const SESSIONS_CHANGED = JSON.stringify({ type: "sessions" });

/** Statuses that show a session as running in the list (session-list.ts). */
const LIVE = new Set(["running", "waiting", "sleeping"]);

/** Conversations with live, non-background work, as one comparable key. */
function liveConversations(graph: TaskGraph) {
  const live = new Set<string>();

  for (const task of Object.values(graph.tasks))
    if (!task.background && LIVE.has(task.state.status)) live.add(String(task.conversationId));

  return [...live].sort().join(",");
}

/** Conversations with any non-background task, whose live doc the feed watches for activity. */
function busyConversations(graph: TaskGraph) {
  const busy = new Map<string, ConversationId>();

  for (const task of Object.values(graph.tasks))
    if (!task.background) busy.set(String(task.conversationId), task.conversationId);

  return busy;
}

/** At most one activity announcement in this window, for all sessions together. */
export const ACTIVITY_THROTTLE_MS = 2_000;

/** A busy session's live doc watch and the activity last seen for it. */
type Watched = {
  id: ConversationId;
  stop: () => void;
  key?: string;
  text?: string | undefined;
};

/**
 * Tells open sidebars that the session list changed, so they refetch at once instead of on their
 * next poll. Sockets hibernate, so an idle tab does not keep the Durable Object awake. Running
 * dots follow the task graph, which is watched only while a sidebar listens. Each busy session's
 * live doc is watched too: when its step may have moved (session-activity.ts liveStepKey), its
 * activity is checked and, if the text changed, announced. Activity announcements are coalesced
 * feed-wide, since each one makes every sidebar refetch the whole list: at most one per
 * ACTIVITY_THROTTLE_MS, trailing, folding every session that moved meanwhile.
 */
export class SessionsFeed {
  private graph?: Promise<void>;
  private stopGraph?: () => Promise<void>;
  private readonly watched = new Map<string, Watched>();
  private readonly dirty = new Set<string>();
  private activityTimer?: ReturnType<typeof setTimeout> | undefined;
  private activityAnnounced = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly harness: () => Harness,
  ) {}

  accept() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [TAG]);
    this.resume();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Something the list shows changed. Cheap when no sidebar is open. */
  changed() {
    for (const socket of this.ctx.getWebSockets(TAG)) {
      try {
        socket.send(SESSIONS_CHANGED);
      } catch {
        // A socket closing as we send; its close handler cleans up.
      }
    }
  }

  /** Watch the task graph while a sidebar listens, including after the object wakes from hibernation. */
  resume() {
    if (this.graph || !this.listening()) return;

    this.graph = this.watchGraph()
      .catch((error) => console.warn("sessions_feed_graph_failed", exceptionDetails(error)))
      .finally(() => {
        this.graph = undefined;
        this.stopGraph = undefined;
      });
  }

  /** A sidebar socket closed; stop the graph watch with the last one. */
  closed(socket: WebSocket) {
    if (this.ctx.getWebSockets(TAG).some((open) => open !== socket)) return;

    void this.stopGraph?.();
  }

  isFeed(socket: WebSocket) {
    return this.ctx.getTags(socket).includes(TAG);
  }

  private listening() {
    return this.ctx.getWebSockets(TAG).length > 0;
  }

  private async watchGraph() {
    const watch = await this.harness().watchTaskGraph(BACKGROUND_CONTEXT);
    this.stopGraph = async () => {
      await watch.stop();
    };

    let live = liveConversations(watch.value);
    this.watchBusy(busyConversations(watch.value));

    watch.start(async (call) => {
      if (call.kind !== "value") return;

      if (!this.listening()) {
        void watch.stop();

        return;
      }

      const next = liveConversations(call.value);
      this.watchBusy(busyConversations(call.value));

      if (next === live) return;
      live = next;
      this.changed();
    });

    try {
      await watch.closed;
    } finally {
      for (const key of this.watched.keys()) this.unwatch(key);
      clearTimeout(this.activityTimer);
      this.activityTimer = undefined;
    }
  }

  /** Watch the live docs of sessions that became busy, and stop those that settled. */
  private watchBusy(busy: Map<string, ConversationId>) {
    for (const key of this.watched.keys()) if (!busy.has(key)) this.unwatch(key);

    for (const [key, id] of busy) if (!this.watched.has(key)) void this.watchLive(key, id);
  }

  private async watchLive(key: string, id: ConversationId) {
    let stopped = false;

    const entry: Watched = {
      id,
      stop: () => {
        stopped = true;
      },
    };

    this.watched.set(key, entry);

    // What the list already shows when it starts, learned without an announcement.
    void sessionActivity(this.harness(), id, [])
      .then((text) => {
        entry.text = text;
      })
      .catch(() => {});

    const watch = await this.harness()
      .watchDoc(LiveDoc, id, BACKGROUND_CONTEXT)
      .catch(() => undefined);

    if (!watch) return;

    if (stopped || this.watched.get(key) !== entry) {
      void watch.stop();

      return;
    }

    entry.stop = () => void watch.stop();
    entry.key = liveStepKey(watch.value);

    watch.start(async (call) => {
      if (call.kind !== "value" || this.watched.get(key) !== entry) return;

      const next = liveStepKey(call.value);

      if (next === entry.key) return;
      entry.key = next;
      this.activityMoved(key);
    });
  }

  private unwatch(key: string) {
    this.watched.get(key)?.stop();
    this.watched.delete(key);
    this.dirty.delete(key);
  }

  /** A session's step may have moved: check it with the others in the next feed-wide window. */
  private activityMoved(key: string) {
    this.dirty.add(key);

    if (this.activityTimer) return;

    const wait = Math.max(0, this.activityAnnounced + ACTIVITY_THROTTLE_MS - Date.now());

    this.activityTimer = setTimeout(() => {
      this.activityTimer = undefined;
      void this.checkActivity();
    }, wait);
  }

  private async checkActivity() {
    const moved = [...this.dirty].flatMap((key) => {
      const entry = this.watched.get(key);

      return entry ? [entry] : [];
    });

    this.dirty.clear();

    // Compared in memory only and never sent, so it needs no redaction here; the list redacts.
    const changes = await Promise.all(
      moved.map(async (entry) => {
        const text = await sessionActivity(this.harness(), entry.id, []).catch(() => entry.text);

        if (text === entry.text) return false;
        entry.text = text;

        return true;
      }),
    );

    if (!changes.includes(true)) return;
    this.activityAnnounced = Date.now();
    this.changed();
  }
}
