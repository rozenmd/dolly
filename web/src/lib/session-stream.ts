import * as Schema from "effect/Schema";
import { Snapshot } from "./api";

/** Each connection starts with a fresh snapshot; timers only retry dropped sockets. */
export function watchSession(
  id: string,
  onSnapshot: (snapshot: typeof Snapshot.Type) => void,
  onError: (message: string) => void,
) {
  let stopped = false;
  let socket: WebSocket;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  function connect() {
    const url = new URL(`/api/sessions/${encodeURIComponent(id)}/events`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      if (stopped) return;

      try {
        const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(Snapshot))(event.data);
        attempts = 0;
        onSnapshot(snapshot);
      } catch {
        onError("Could not read the session update. Reconnecting…");
        socket.close();
      }
    };

    socket.onerror = () => {
      if (!stopped) onError("Session connection lost. Reconnecting…");
      socket.close();
    };

    socket.onclose = () => {
      if (stopped) return;
      onError("Session connection lost. Reconnecting…");
      timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 30_000));
    };
  }

  connect();

  return () => {
    stopped = true;
    clearTimeout(timer);
    socket.close();
  };
}
