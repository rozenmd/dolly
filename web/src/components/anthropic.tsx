import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import { anthropicStatus, request } from "../lib/api";
import { Input } from "./ui";

const Probe = Schema.Struct({
  ok: Schema.Boolean,
  model: Schema.String,
  durationMs: Schema.Number,
  message: Schema.String,
  upstream: Schema.NullOr(Schema.Struct({ status: Schema.Number, contentType: Schema.String, requestId: Schema.NullOr(Schema.String), rayId: Schema.NullOr(Schema.String) })),
});

export function AnthropicConnection({ onConnection }: { onConnection: (connected: boolean) => void }) {
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<typeof Probe.Type | null>(null);
  const notify = useRef(onConnection);
  notify.current = onConnection;

  useEffect(() => {
    let active = true;
    anthropicStatus().then((status) => {
      if (!active) return;
      setConnected(status.connected);
      setLoaded(true);
      notify.current(status.connected);
    }, (cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load Claude status.");
    });

    return () => { active = false; };
  }, []);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");

    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Claude request failed."); }
    finally { setPending(false); }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await request("/auth/anthropic", { token }, undefined, "PUT");
      setToken("");
      setConnected(true);
      setLoaded(true);
      setProbe(null);
      notify.current(true);
    });
  }

  return <section className="anthropic-connection" aria-label="Claude connection">
    <h3>Claude subscription <span className="muted">Experimental</span></h3>
    <p className="field-help">Run <code>claude setup-token</code> on your computer, then paste the token here. This uses your Claude subscription, not a billed API key. Setup tokens are stored only on the server and must be replaced manually when they expire.</p>
    <p className="muted">{!loaded ? "Checking connection…" : connected ? "Token saved. A live test is needed to verify Worker access." : "Not connected"}</p>
    <form onSubmit={save}>
      <label htmlFor="claude-token">Claude setup token</label>
      <Input id="claude-token" name="claude-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required disabled={pending} placeholder="sk-ant-oat01-…" />
      <button type="submit" className="secondary-button" disabled={pending || !token.trim()}>{connected ? "Replace token" : "Save token"}</button>
    </form>
    <p className="field-help">Test connection sends one small real Claude request from this Worker and consumes subscription usage. Saving a token does not make a model request.</p>
    <div className="modal-actions">
      <button type="button" className="secondary-button" disabled={!connected || pending} onClick={() => void run(async () => {
        setProbe(Schema.decodeUnknownSync(Schema.fromJsonString(Probe))(await request("/auth/anthropic/test", {})));
      })}>Test connection</button>
      {connected && <button type="button" className="ghost-button" disabled={pending} onClick={() => void run(async () => {
        await request("/auth/anthropic", undefined, undefined, "DELETE");
        setConnected(false);
        setProbe(null);
        notify.current(false);
      })}>Disconnect Claude</button>}
    </div>
    {probe && <div role={probe.ok ? "status" : "alert"} className={probe.ok ? "field-help" : "error-text"}>
      <p>{probe.message}</p>
      <p>{probe.model} · {probe.durationMs} ms{probe.upstream ? ` · HTTP ${probe.upstream.status} · ${probe.upstream.contentType}` : ""}</p>
      {probe.upstream?.requestId && <p>Request ID: {probe.upstream.requestId}</p>}
      {probe.upstream?.rayId && <p>Ray ID: {probe.upstream.rayId}</p>}
    </div>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}
