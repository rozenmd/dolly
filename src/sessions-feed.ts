import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, TaskGraph } from "@earendil-works/pi-durable";
import { exceptionDetails } from "./diagnostics";
import { sessionActivity } from "./session-activity";

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

/**
 * Each live conversation's non-background tasks, as one comparable key per conversation. A new
 * tool call or generation changes it, so it says when activity may have moved.
 */
function liveTasks(graph: TaskGraph) {
  const tasks = new Map<string, { id: ConversationId; tasks: string[] }>();

  for (const [key, task] of Object.entries(graph.tasks)) {
    if (task.background) continue;
    const id = String(task.conversationId);
    const entry = tasks.get(id) ?? { id: task.conversationId, tasks: [] };
    entry.tasks.push(key);
    tasks.set(id, entry);
  }

  return new Map(
    [...tasks].map(([id, entry]) => [id, { id: entry.id, key: entry.tasks.sort().join(",") }]),
  );
}

/** At most one announcement per session in this window for its activity. */
export const ACTIVITY_THROTTLE_MS = 2_000;

type Activity = {
  text?: string | undefined;
  /** When this session's activity last caused an announcement. */
  announced: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Tells open sidebars that the session list changed, so they refetch at once instead of on their
 * next poll. Sockets hibernate, so an idle tab does not keep the Durable Object awake. Running
 * dots follow the task graph, which is watched only while a sidebar listens. A running session's
 * activity (session-activity.ts) is checked when its tasks change, announced only when its text
 * changed, and at most once per session every ACTIVITY_THROTTLE_MS: a check due sooner waits,
 * and changes meanwhile fold into it.
 */
export class SessionsFeed {
  private graph?: Promise<void>;
  private stopGraph?: () => Promise<void>;
  private readonly activity = new Map<string, Activity>();

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
    let tasks = liveTasks(watch.value);

    // The list a sidebar fetches on connect already shows these; learn them without announcing.
    for (const [key, entry] of tasks) {
      const state: Activity = { announced: 0 };
      this.activity.set(key, state);
      void this.checkActivity(key, entry.id, state, false);
    }

    watch.start(async (call) => {
      if (call.kind !== "value") return;

      if (!this.listening()) {
        void watch.stop();

        return;
      }

      const next = liveConversations(call.value);
      const nextTasks = liveTasks(call.value);

      for (const [id, entry] of nextTasks)
        if (tasks.get(id)?.key !== entry.key) this.activityMoved(id, entry.id);

      for (const id of tasks.keys()) if (!nextTasks.has(id)) this.forgetActivity(id);
      tasks = nextTasks;

      if (next === live) return;
      live = next;
      this.changed();
    });

    try {
      await watch.closed;
    } finally {
      for (const state of this.activity.values()) clearTimeout(state.timer);
      this.activity.clear();
    }
  }

  /** A session's tasks changed: check its activity now, or once its throttle window ends. */
  private activityMoved(key: string, id: ConversationId) {
    const state = this.activity.get(key) ?? { announced: 0 };
    this.activity.set(key, state);

    if (state.timer) return;

    const wait = Math.max(0, state.announced + ACTIVITY_THROTTLE_MS - Date.now());

    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.checkActivity(key, id, state);
    }, wait);
  }

  private async checkActivity(key: string, id: ConversationId, state: Activity, announce = true) {
    // Compared in memory only and never sent, so it needs no redaction here; the list redacts.
    const text = await sessionActivity(this.harness(), id, []).catch(() => state.text);

    if (this.activity.get(key) !== state || text === state.text) return;

    state.text = text;

    if (!announce) return;
    state.announced = Date.now();
    this.changed();
  }

  private forgetActivity(key: string) {
    const state = this.activity.get(key);

    if (state?.timer) clearTimeout(state.timer);
    this.activity.delete(key);
  }
}
