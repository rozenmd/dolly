import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import {
  ArrowPathIcon,
  EllipsisHorizontalIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { request } from "../lib/api";
import { Input, Modal, Textarea } from "./ui";

/**
 * Settings > Connections: the MCP servers every session gets tools from. Works like Opensession's
 * Connections page: live status per server, OAuth or API-token connect from each row's menu,
 * add and remove. Server-side behaviour lives in src/mcp.ts.
 */

const McpConnection = Schema.Struct({
  name: Schema.String,
  transport: Schema.Literal("http"),
  target: Schema.String,
  headerKeys: Schema.Array(Schema.String),
  status: Schema.Literals(["connected", "needs-auth", "unreachable"]),
  detail: Schema.optional(Schema.String),
});

type McpConnection = typeof McpConnection.Type;

const ConnectionsData = Schema.Struct({ mcpServers: Schema.Array(McpConnection) });

const OauthStatus = Schema.Struct({
  shared: Schema.optional(
    Schema.Struct({ connectedBy: Schema.optional(Schema.String), updatedAt: Schema.String }),
  ),
  users: Schema.Array(Schema.String),
  manualToken: Schema.Boolean,
});

type OauthStatus = typeof OauthStatus.Type;

const STATUS_META: Record<McpConnection["status"], { label: string; dot: string; bad: boolean }> = {
  connected: { label: "Connected", dot: "connected", bad: false },
  "needs-auth": { label: "Sign in required", dot: "needs-auth", bad: true },
  unreachable: { label: "Unreachable", dot: "unreachable", bad: true },
};

const MCP_BLURBS = new Map<string, string>([
  ["linear", "Issues and projects: read and update Linear"],
  ["plain", "Customer support threads from Plain"],
  ["sentry", "Errors and performance issues"],
  ["workos", "User & organization admin"],
  ["tinybird", "Analytics queries over product events"],
  ["stripe", "Billing, subscriptions & refunds"],
  ["amplitude", "Product analytics events"],
  ["grafana", "Dashboards, logs & metrics"],
  ["incident", "incident.io: incidents and on-call"],
  ["slack", "Post & read Slack messages"],
  ["ahrefs", "SEO, keywords & backlink data"],
  ["github", "Repos, issues & pull requests"],
  ["circle", "Community & support workspace"],
  ["vercel", "Projects, deployments & logs"],
  ["vero", "Broadcasts and customer journeys"],
  ["oneleet", "Compliance controls, evidence & risks"],
]);

const TOKEN_CONNECT_URLS = new Map([
  [
    "vercel",
    {
      url: "https://vercel.com/account/settings/tokens",
      label: "vercel.com/account/settings/tokens",
    },
  ],
]);

const KNOWN_NAMES = new Map([
  ["github", "GitHub"],
  ["posthog", "PostHog"],
  ["workos", "WorkOS"],
  ["incident", "incident.io"],
]);

export function displayName(name: string) {
  return (
    KNOWN_NAMES.get(name.toLowerCase()) ??
    name
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

const TILE_COLOURS = ["#5e6ad2", "#e0663a", "#c04fd6", "#14a3a3", "#5d9b2f", "#d4a017", "#e0457b"];

function ServerTile({ name }: { name: string }) {
  let hash = 0;

  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return (
    <span
      className="mcp-tile"
      aria-hidden="true"
      style={{ background: TILE_COLOURS[Math.abs(hash) % TILE_COLOURS.length] }}
    >
      {displayName(name).charAt(0).toUpperCase()}
    </span>
  );
}

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const path = (name: string) => `/connections/mcp/${encodeURIComponent(name)}`;

/** `KEY: value` (or `KEY=value`) lines as headers; blank lines are skipped. */
export function parseHeaders(text: string): Record<string, string> {
  const headers = new Map<string, string>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*([^:=\s]+)\s*[:=]\s*(.*)$/);

    if (!match) throw new Error(`Expected "Header: value", got "${line.trim()}"`);
    headers.set(match[1], match[2].trim());
  }

  return Object.fromEntries(headers);
}

export function ConnectionsSettings() {
  const [data, setData] = useState<readonly McpConnection[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState("");
  const [tokenConnect, setTokenConnect] = useState<McpConnection | null>(null);
  const [oauthByName, setOauthByName] = useState<Record<string, OauthStatus>>({});
  const polls = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);

    try {
      const next = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionsData))(
        await request(`/connections${force ? "?refresh=1" : ""}`),
      );

      setData(next.mcpServers);
    } catch (cause) {
      // Keep the last successful snapshot; rows show their own state.
      setError(message(cause, "Could not load connections."));
    }

    setRefreshing(false);
  }, []);

  const loadOauth = useCallback(async (servers: readonly McpConnection[]) => {
    const entries = await Promise.all(
      servers.map(async (server) => {
        try {
          const status = Schema.decodeUnknownSync(Schema.fromJsonString(OauthStatus))(
            await request(`${path(server.name)}/oauth`),
          );

          return [server.name, status] as const;
        } catch {
          return null;
        }
      }),
    );

    setOauthByName(Object.fromEntries(entries.filter((entry) => entry !== null)));
  }, []);

  useEffect(() => {
    void load();

    return () => {
      if (polls.current) clearInterval(polls.current);
    };
  }, [load]);

  useEffect(() => {
    if (data) void loadOauth(data);
  }, [data, loadOauth]);

  async function oauthConnect(server: McpConnection) {
    setError("");
    // Opened before the request so browsers treat it as part of the click.
    const tab = window.open("about:blank", "_blank");

    try {
      const result = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
      )(await request(`${path(server.name)}/oauth/start`, {}, undefined, "POST"));

      if (tab) {
        tab.opener = null;
        tab.location.href = result.url;
      } else window.open(result.url, "_blank", "noopener");

      const connectedBefore = oauthByName[server.name]?.shared?.updatedAt;
      let count = 0;

      if (polls.current) clearInterval(polls.current);
      polls.current = setInterval(() => {
        count += 1;

        void request(`${path(server.name)}/oauth`)
          .then((text) => Schema.decodeUnknownSync(Schema.fromJsonString(OauthStatus))(text))
          .then((status) => {
            setOauthByName((current) => ({ ...current, [server.name]: status }));

            if (status.shared && status.shared.updatedAt !== connectedBefore) {
              if (polls.current) clearInterval(polls.current);
              void load(true);
            }
          })
          .catch(() => {});

        if (count >= 24 && polls.current) clearInterval(polls.current);
      }, 5000);
    } catch (cause) {
      tab?.close();
      setError(message(cause, `Could not connect ${server.name}`));
    }
  }

  async function oauthDisconnect(server: McpConnection) {
    setError("");

    try {
      await request(`${path(server.name)}/oauth`, undefined, undefined, "DELETE");
      await load(true);
    } catch (cause) {
      setError(message(cause, `Could not disconnect ${server.name}`));
    }
  }

  async function remove(name: string) {
    if (!confirm(`Remove MCP server "${name}"? New sessions will no longer get its tools.`)) return;
    setError("");

    try {
      await request(path(name), undefined, undefined, "DELETE");
      await load(true);
    } catch (cause) {
      setError(message(cause, `Could not remove ${name}`));
    }
  }

  return (
    <section className="settings-section">
      <div className="connections-header">
        <h1>Connections</h1>
        <div className="connections-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <ArrowPathIcon width={16} className={refreshing ? "spin" : ""} aria-hidden="true" />
            {refreshing ? "Checking…" : "Re-check"}
          </button>
          <button type="button" className="primary-button" onClick={() => setShowAdd(true)}>
            <PlusIcon width={16} aria-hidden="true" />
            Add MCP server
          </button>
        </div>
      </div>
      <p className="settings-description">
        MCP servers give every session extra tools. Calls run in dolly's Worker with the credentials
        stored here; sandboxes never see them.
      </p>

      {error && (
        <div role="alert" className="inline-alert">
          <span>{error}</span>
          <button type="button" className="secondary-button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}

      {showAdd && (
        <AddMcpForm
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            void load(true);
          }}
        />
      )}

      <h2 className="settings-group-label">MCP servers: tools inside every session</h2>
      {!data ? (
        <div className="settings-card mcp-list" aria-busy="true">
          <p className="field-help">Checking connections…</p>
        </div>
      ) : data.length === 0 ? (
        <div className="settings-card mcp-list">
          <p className="field-help">
            No MCP servers yet. Add one, such as https://mcp.linear.app/mcp, to give every session
            its tools.
          </p>
        </div>
      ) : (
        <ul className="settings-card mcp-list">
          {data.map((server) => {
            const meta = STATUS_META[server.status];
            const oauth = oauthByName[server.name];

            return (
              <li key={server.name} className="mcp-row">
                <ServerTile name={server.name} />
                <div className="mcp-body">
                  <div className="mcp-title">
                    <span className="mcp-name">{displayName(server.name)}</span>
                    {oauth?.shared && (
                      <span
                        className="mcp-pill"
                        title={`Workspace grant${oauth.shared.connectedBy ? ` (by ${oauth.shared.connectedBy})` : ""}`}
                      >
                        {oauth.manualToken ? "Token" : "OAuth"} · workspace
                      </span>
                    )}
                  </div>
                  <div className="mcp-blurb">{MCP_BLURBS.get(server.name) ?? "MCP server"}</div>
                  <div className="mcp-meta">
                    <span className="mcp-chip">{server.transport}</span>
                    <span className="mcp-target" title={server.target}>
                      {server.target}
                    </span>
                    {server.headerKeys.length > 0 && (
                      <span className="mcp-chip" title={server.headerKeys.join(", ")}>
                        {server.headerKeys.length === 1
                          ? server.headerKeys[0]
                          : `${server.headerKeys.length} headers`}
                      </span>
                    )}
                  </div>
                  {meta.bad && server.detail && (
                    <div className="mcp-detail" title={server.detail}>
                      {server.detail}
                    </div>
                  )}
                </div>
                <span className="mcp-status">
                  <span className={`mcp-dot ${meta.dot}`} />
                  {meta.label}
                </span>
                <RowMenu
                  label={`Manage ${server.name}`}
                  items={[
                    {
                      label: oauth?.shared ? "Reconnect (workspace)" : "Connect (workspace)",
                      icon: <PlusIcon />,
                      onSelect: () => void oauthConnect(server),
                      hidden: oauth?.manualToken,
                    },
                    {
                      label: "Connect with API token",
                      icon: <KeyIcon />,
                      onSelect: () => setTokenConnect(server),
                      hidden: !oauth?.manualToken,
                    },
                    {
                      label: oauth?.manualToken ? "Disconnect token" : "Disconnect OAuth",
                      icon: <TrashIcon />,
                      onSelect: () => void oauthDisconnect(server),
                      hidden: !oauth?.shared,
                    },
                    {
                      label: "Remove server",
                      icon: <TrashIcon />,
                      onSelect: () => void remove(server.name),
                      danger: true,
                      separated: true,
                    },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      )}

      {tokenConnect && (
        <ConnectTokenDialog
          server={tokenConnect}
          onClose={() => setTokenConnect(null)}
          onConnected={() => {
            setTokenConnect(null);
            void load(true);
          }}
        />
      )}
    </section>
  );
}

type MenuItem = {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  hidden?: boolean;
  danger?: boolean;
  separated?: boolean;
};

function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const visible = items.filter((item) => !item.hidden);

  useEffect(() => {
    if (!open) return;

    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();

    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="picker mcp-menu">
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <EllipsisHorizontalIcon width={18} />
      </button>
      {open && (
        <div className="picker-menu align-end" role="menu" aria-label={label}>
          {visible.map((item) => (
            <div key={item.label} role="presentation">
              {item.separated && visible.length > 1 && <hr className="mcp-separator" />}
              <button
                type="button"
                role="menuitem"
                className={`picker-action${item.danger ? " danger" : ""}`}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="picker-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="picker-label">{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Paste-a-token connect for providers whose hosted MCP gates OAuth client registration (Vercel
 * approves only clients it has reviewed). The server checks the token with the provider before
 * storing it.
 */
function ConnectTokenDialog({
  server,
  onClose,
  onConnected,
}: {
  server: McpConnection;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const tokenPage = TOKEN_CONNECT_URLS.get(server.name);

  async function connect(event: FormEvent) {
    event.preventDefault();

    if (!token.trim() || saving) return;
    setSaving(true);
    setError("");

    try {
      await request(`${path(server.name)}/token`, { token: token.trim() }, undefined, "POST");
      onConnected();
    } catch (cause) {
      setError(message(cause, `Could not connect ${server.name}`));
    }

    setSaving(false);
  }

  return (
    <Modal title={`Connect ${displayName(server.name)} with an API token`} onClose={onClose}>
      <form onSubmit={(event) => void connect(event)}>
        <p className="field-help">
          The token is checked with the provider, then stored for agent runs.
          {tokenPage && (
            <>
              {" "}
              Create one at{" "}
              <a href={tokenPage.url} target="_blank" rel="noreferrer">
                {tokenPage.label}
              </a>
              , then paste it here.
            </>
          )}
        </p>
        <label htmlFor="mcp-token">API token</label>
        <Input
          id="mcp-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste API token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!token.trim() || saving}>
            {saving ? "Checking" : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AddMcpForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function add(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      await request(
        "/connections/mcp",
        { name: name.trim(), transport: "http", url: url.trim(), headers: parseHeaders(headers) },
        undefined,
        "POST",
      );
      onAdded();
    } catch (cause) {
      setError(message(cause, "Could not add MCP server"));
      setSaving(false);
    }
  }

  const valid = name.trim() && url.trim();

  return (
    <form className="settings-card" onSubmit={(event) => void add(event)}>
      <h2 className="settings-step">Add MCP server</h2>
      <div className="mcp-form-row">
        <div>
          <label htmlFor="mcp-name">Name</label>
          <Input
            id="mcp-name"
            autoCapitalize="none"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="linear"
          />
        </div>
        <div>
          <label htmlFor="mcp-transport">Transport</label>
          <Input id="mcp-transport" value="http · remote MCP endpoint" disabled readOnly />
        </div>
      </div>
      <label htmlFor="mcp-url">URL</label>
      <Input
        id="mcp-url"
        type="url"
        autoCapitalize="none"
        spellCheck={false}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://mcp.linear.app/mcp"
      />
      <label htmlFor="mcp-headers">
        Headers (optional, one per line; values are never shown again)
      </label>
      <Textarea
        id="mcp-headers"
        className="mono"
        rows={2}
        spellCheck={false}
        value={headers}
        onChange={(event) => setHeaders(event.target.value)}
        placeholder="Authorization: Bearer <api-key>"
      />
      <p className="field-help">
        Leave headers blank for servers that sign in with OAuth, then choose Connect from the row's
        menu. Local stdio servers aren't supported: dolly runs in a Worker.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={saving || !valid}>
          {saving ? "Adding…" : "Add server"}
        </button>
      </div>
    </form>
  );
}
