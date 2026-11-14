import { afterEach, expect, it, vi } from "vite-plus/test";
import { watchSession } from "./session-stream";

class Socket {
  static instances: Socket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: URL) {
    Socket.instances.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Socket.instances = [];
});

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: { href: "https://dolly.example/" } });
  vi.stubGlobal("WebSocket", Socket);
  const update = vi.fn();
  const error = vi.fn();
  const stop = watchSession("a/b", update, error);

  return { update, error, stop };
}

it("receives snapshots without polling and closes on cleanup", () => {
  const { update, stop } = setup();
  const socket = Socket.instances[0];
  expect(socket.url.href).toBe("wss://dolly.example/api/sessions/a%2Fb/events");
  socket.onmessage!({ data: JSON.stringify({ entries: [], docs: {} }) });
  expect(update).toHaveBeenCalledWith({ entries: [], docs: {} });
  vi.advanceTimersByTime(60_000);
  expect(Socket.instances).toHaveLength(1);
  stop();
  expect(socket.close).toHaveBeenCalled();
  socket.onmessage!({ data: JSON.stringify({ entries: [], docs: {} }) });
  socket.onclose!();
  vi.advanceTimersByTime(60_000);
  expect(update).toHaveBeenCalledTimes(1);
  expect(Socket.instances).toHaveLength(1);
});

it("reconnects dropped sockets with backoff and cancels retries on cleanup", () => {
  const { stop, error } = setup();
  Socket.instances[0].onclose!();
  expect(error).toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(Socket.instances).toHaveLength(2);
  Socket.instances[1].onclose!();
  vi.advanceTimersByTime(1999);
  expect(Socket.instances).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(Socket.instances).toHaveLength(3);
  Socket.instances[2].onclose!();
  stop();
  vi.advanceTimersByTime(60_000);
  expect(Socket.instances).toHaveLength(3);
});

it("rejects malformed snapshots", () => {
  const { update, error, stop } = setup();
  Socket.instances[0].onmessage!({ data: "not json" });
  expect(update).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  expect(Socket.instances[0].close).toHaveBeenCalled();
  stop();
});
