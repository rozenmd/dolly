/**
 * A minimal Chrome DevTools Protocol client over one browser-level WebSocket, with
 * flattened target sessions. It works with any CDP endpoint: a local Chrome, a
 * container such as chromedp/headless-shell, or Cloudflare Browser Run.
 */
type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string; data?: string };
  sessionId?: string;
};

type Listener = (params: any, sessionId?: string) => void;

export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; method: string }
  >();
  private readonly listeners = new Map<string, Set<Listener>>();
  closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message: Message = JSON.parse(String(event.data));

      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);

        if (!waiter) return;
        this.pending.delete(message.id);

        if (message.error)
          waiter.reject(
            new Error(
              `${waiter.method}: ${message.error.message}${message.error.data ? ` (${message.error.data})` : ""}`,
            ),
          );
        else waiter.resolve(message.result ?? {});

        return;
      }

      if (!message.method) return;

      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {}, message.sessionId);
    });
    socket.addEventListener("close", () => {
      this.closed = true;

      for (const waiter of this.pending.values())
        waiter.reject(new Error(`${waiter.method}: browser connection closed`));
      this.pending.clear();
    });
  }

  static async connect(url: string, token?: string) {
    // SAFETY: Node's WebSocket (undici) accepts an init object with headers, which
    // Browser Run needs for its API token; the DOM typings only allow protocols.
    const init = { headers: token ? { Authorization: `Bearer ${token}` } : {} } as unknown as string[];
    const socket = new WebSocket(url, init);

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`Could not connect to the browser at ${url}`)),
        { once: true },
      );
    });

    return new CdpConnection(socket);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed) return Promise.reject(new Error(`${method}: browser connection closed`));
    const id = ++this.nextId;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, listener: Listener) {
    let set = this.listeners.get(method);

    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);

    return () => set.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

/** Commands and events scoped to one attached target. */
export class CdpSession {
  private readonly disposers: (() => void)[] = [];

  constructor(
    readonly connection: CdpConnection,
    readonly sessionId: string,
  ) {}

  send<T = any>(method: string, params: Record<string, unknown> = {}) {
    return this.connection.send<T>(method, params, this.sessionId);
  }

  on(method: string, listener: (params: any) => void) {
    const dispose = this.connection.on(method, (params, sessionId) => {
      if (sessionId === this.sessionId) listener(params);
    });

    this.disposers.push(dispose);

    return dispose;
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}

/** Resolve an http(s) DevTools address to its browser WebSocket; pass ws(s) URLs through. */
export async function browserWebSocket(endpoint: string) {
  if (/^wss?:/.test(endpoint)) return endpoint;
  const response = await fetch(new URL("/json/version", endpoint));

  if (!response.ok) throw new Error(`${endpoint}/json/version returned HTTP ${response.status}`);
  const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string };
  // Containers report their internal address; keep the host the caller reached.
  const reported = new URL(webSocketDebuggerUrl);
  reported.host = new URL(endpoint).host;

  return reported.toString();
}
