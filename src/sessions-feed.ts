import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskGraph } from "@earendil-works/pi-durable";
import { exceptionDetails } from "./diagnostics";

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
 * Tells open sidebars that the session list changed, so they refetch at once instead of on their
 * next poll. Sockets hibernate, so an idle tab does not keep the Durable Object awake. Running
 * dots follow the task graph, which is watched only while a sidebar listens.
 */
export class SessionsFeed {
  private graph?: Promise<void>;
  private stopGraph?: () => Promise<void>;

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

    watch.start(async (call) => {
      if (call.kind !== "value") return;

      if (!this.listening()) {
        void watch.stop();

        return;
      }

      const next = liveConversations(call.value);

      if (next === live) return;
      live = next;
      this.changed();
    });

    await watch.closed;
  }
}
