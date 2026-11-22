import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowPathIcon,
  PauseIcon,
  PencilSquareIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { request, type ApiBody } from "../lib/api";
import {
  SCHEDULE_PRESETS,
  dateTimeInput,
  deleteAutomation,
  describeSchedule,
  listAutomations,
  localTimeZone,
  runAutomation,
  saveAutomation,
  shortDateTime,
  type Automation,
  type AutomationRun,
} from "../lib/automations";
import { ago } from "../lib/time";
import { untilLabel } from "../lib/scheduled";
import { RowMenu, displayName } from "./connections";
import { ModelPicker } from "./model-select";
import { RepositoryPicker } from "./repositories";
import { Input, Select, Textarea } from "./ui";

/**
 * Settings > Automations, after OpenSession's: prompts that start a fresh session on a schedule,
 * once at a set time, or when run by hand. Behaviour lives in src/automations.ts.
 */

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const STATUS: Record<AutomationRun["status"], { label: string; dot: string }> = {
  running: { label: "Running", dot: "working pulse" },
  succeeded: { label: "Succeeded", dot: "idle" },
  failed: { label: "Failed", dot: "failed" },
  skipped: { label: "Skipped", dot: "" },
};

function whenLabel(automation: Automation) {
  if (automation.schedule)
    return `${describeSchedule(automation.schedule)}${automation.timeZone && automation.timeZone !== "UTC" ? ` (${automation.timeZone})` : " (UTC)"}`;

  if (automation.runAt !== undefined) return `Once, ${shortDateTime(automation.runAt)}`;

  return "Only when run by hand";
}

function RunLine({ run, now }: { run: AutomationRun; now: number }) {
  const status = STATUS[run.status];
  const detail = run.error ?? run.summary;

  return (
    <li className="automation-run">
      <span className={`status-dot ${status.dot}`} aria-hidden="true" />
      <span className="automation-run-status">{status.label}</span>
      <span className="muted">
        {run.trigger === "manual" ? "by hand" : "scheduled"} · {ago(run.at, now)} ago
      </span>
      {detail && (
        <span className="automation-run-detail" title={detail}>
          {detail}
        </span>
      )}
      {run.sessionId && (
        <Link
          to="/session/$sessionId"
          params={{ sessionId: run.sessionId }}
          className="automation-run-link"
        >
          Open session
        </Link>
      )}
    </li>
  );
}

export function AutomationsSettings() {
  const [automations, setAutomations] = useState<readonly Automation[] | null>(null);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setAutomations(await listAutomations(signal));
      setNow(Date.now());
    } catch (cause) {
      if (!signal?.aborted) setError(message(cause, "Could not load automations."));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    // Runs settle on their own; keep their status current while the page is open.
    const timer = setInterval(() => void load(controller.signal), 15_000);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  async function act(id: string, action: () => Promise<void>, failure: string) {
    setBusy(id);
    setError("");

    try {
      await action();
      await load();
    } catch (cause) {
      setError(message(cause, failure));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="settings-section">
      <div className="connections-header">
        <h1>Automations</h1>
        <div className="connections-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void load()}
            aria-label="Refresh automations"
          >
            <ArrowPathIcon width={16} aria-hidden="true" />
            Refresh
          </button>
          <button type="button" className="primary-button" onClick={() => setEditing("new")}>
            <PlusIcon width={16} aria-hidden="true" />
            New automation
          </button>
        </div>
      </div>
      <p className="settings-description">
        Prompts that run on their own: on a schedule, once at a set time, or when you press Run.
        Each run is a fresh session with no memory of earlier runs; open it from here or the sidebar
        to read, steer or stop it. Runs can open pull requests but never merge them.
      </p>

      {error && (
        <div role="alert" className="inline-alert">
          <span>{error}</span>
          <button type="button" className="secondary-button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}

      {editing && (
        <AutomationForm
          // A row saved since the form opened opens afresh: Edit again must show what is saved now.
          key={editing === "new" ? "new" : `${editing.id}:${editing.updatedAt}`}
          automation={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {!automations ? (
        <div className="settings-card mcp-list" aria-busy="true">
          <p className="field-help">Loading automations…</p>
        </div>
      ) : automations.length === 0 ? (
        <div className="settings-card mcp-list">
          <p className="field-help">
            No automations yet. Try a weekly stale pull request report, a nightly dependency check,
            or a reminder to look at a deploy tomorrow morning.
          </p>
        </div>
      ) : (
        <ul className="settings-card mcp-list" aria-label="Automations">
          {automations.map((automation) => {
            const last = automation.runs[0];
            // A skipped fire can be newer than the run still going: look past it.
            const running = automation.runs.some((run) => run.status === "running");

            return (
              <li key={automation.id} className="automation-row">
                <div className="mcp-row automation-head">
                  <span
                    className={`status-dot ${last ? STATUS[last.status].dot : ""}`}
                    aria-label={last ? `Last run: ${STATUS[last.status].label}` : "Never run"}
                  />
                  <div className="mcp-body">
                    <div className="mcp-title">
                      <span className="mcp-name">{automation.name}</span>
                      {!automation.enabled && <span className="mcp-pill paused">Paused</span>}
                      {automation.readOnly && (
                        <span className="mcp-pill muted-pill">Read-only</span>
                      )}
                    </div>
                    <div className="mcp-blurb" title={automation.prompt}>
                      {automation.prompt}
                    </div>
                    <div className="mcp-meta">
                      <span className="mcp-chip">{whenLabel(automation)}</span>
                      {automation.workspace && (
                        <span className="mcp-target">{automation.workspace.repository}</span>
                      )}
                      {automation.nextRunAt !== undefined && (
                        <span
                          className="automation-next"
                          title={new Date(automation.nextRunAt).toLocaleString()}
                        >
                          next {untilLabel(automation.nextRunAt, now)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="secondary-button automation-run-button"
                    disabled={running || busy === automation.id}
                    onClick={() =>
                      void act(
                        automation.id,
                        async () => {
                          await runAutomation(automation.id);
                        },
                        `Could not run ${automation.name}.`,
                      )
                    }
                  >
                    <PlayIcon width={16} aria-hidden="true" />
                    {running ? "Running" : "Run now"}
                  </button>
                  <RowMenu
                    label={`Manage ${automation.name}`}
                    items={[
                      {
                        label: "Edit",
                        icon: <PencilSquareIcon />,
                        onSelect: () => setEditing(automation),
                      },
                      {
                        label: automation.enabled ? "Pause" : "Resume",
                        icon: automation.enabled ? <PauseIcon /> : <PlayIcon />,
                        onSelect: () =>
                          void act(
                            automation.id,
                            async () => {
                              await saveAutomation(automation.id, {
                                enabled: !automation.enabled,
                              });
                            },
                            `Could not update ${automation.name}.`,
                          ),
                      },
                      {
                        label: "Delete",
                        icon: <TrashIcon />,
                        danger: true,
                        separated: true,
                        onSelect: () => {
                          if (
                            !confirm(
                              `Delete "${automation.name}"? Sessions it already started stay.`,
                            )
                          )
                            return;
                          void act(
                            automation.id,
                            () => deleteAutomation(automation.id),
                            `Could not delete ${automation.name}.`,
                          );
                        },
                      },
                    ]}
                  />
                </div>
                {automation.runs.length > 0 && (
                  <details className="automation-runs">
                    <summary>
                      Recent runs ({automation.runs.length})
                      {last && (
                        <span className="muted">
                          {" "}
                          · last {STATUS[last.status].label.toLowerCase()} {ago(last.at, now)} ago
                        </span>
                      )}
                    </summary>
                    <ul>
                      {automation.runs.map((run) => (
                        <RunLine
                          key={`${run.at}-${run.sessionId ?? run.status}`}
                          run={run}
                          now={now}
                        />
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

type When = "schedule" | "once" | "manual";

/** Everything the form edits, as it stands. */
type FormValues = {
  name: string;
  prompt: string;
  when: When;
  schedule: string;
  timeZone: string;
  /** A `datetime-local` value; empty when cleared. */
  runAt: string;
  repository: string;
  ref: string;
  readOnly: boolean;
  model: string;
  mcpServers: readonly string[];
  enabled: boolean;
};

/** The values a form opens with: an automation's, or a new one's defaults. */
function initialValues(automation: Automation | undefined): FormValues {
  return {
    name: automation?.name ?? "",
    prompt: automation?.prompt ?? "",
    when:
      !automation || automation.schedule
        ? "schedule"
        : automation.runAt !== undefined
          ? "once"
          : "manual",
    schedule: automation?.schedule ?? SCHEDULE_PRESETS[1].schedule,
    // The API reads a schedule without a zone as UTC; only a new schedule starts in the browser's.
    timeZone: automation?.schedule ? (automation.timeZone ?? "UTC") : localTimeZone(),
    runAt: dateTimeInput(
      new Date(automation?.runAt ?? Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000),
    ),
    repository: automation?.workspace?.repository ?? "",
    ref: automation?.workspace?.ref ?? "",
    readOnly: automation?.readOnly ?? false,
    model: automation?.model ?? "",
    mcpServers: automation?.mcpServers ?? [],
    enabled: automation?.enabled ?? true,
  };
}

/** The full API body for `values`, or why it can't be saved. */
function bodyOf(values: FormValues): { error: string } | { body: ApiBody } {
  const at = values.when === "once" ? new Date(values.runAt) : undefined;

  if (at && Number.isNaN(at.getTime())) return { error: "Choose a date and time to run it at." };

  return {
    body: {
      name: values.name.trim(),
      prompt: values.prompt.trim(),
      enabled: values.enabled,
      readOnly: Boolean(values.repository) && values.readOnly,
      model: values.model || null,
      mcpServers: values.readOnly ? [] : values.mcpServers,
      schedule: values.when === "schedule" ? values.schedule.trim() : null,
      timeZone: values.when === "schedule" ? values.timeZone.trim() || null : null,
      runAt: at ? at.toISOString() : null,
      workspace: values.repository
        ? {
            repository: values.repository,
            ...(values.ref && { ref: values.ref }),
            // Never sent: the form doesn't edit network hosts, and the server keeps the ones
            // it holds for the same repository, so a stale form can't restore revoked hosts.
          }
        : null,
    },
  };
}

const differs = <T,>(a: T, b: T) => JSON.stringify(a) !== JSON.stringify(b);

/**
 * What an edit sends: only the fields the owner changed. Resending the rest would re-validate an
 * old one-off time, or undo a pause made from the list while the form was open.
 */
function patchOf(body: ApiBody, initial: ApiBody): ApiBody {
  // What a run may do is the repository, read-only and MCP servers together: a change to any one
  // sends all three as shown, so a concurrent edit to another can't combine into access nobody
  // chose (another tab turning read-only off while this one moves the repository).
  const access =
    differs(body.workspace, initial.workspace) ||
    differs(body.readOnly, initial.readOnly) ||
    differs(body.mcpServers, initial.mcpServers);

  return {
    ...(differs(body.name, initial.name) && { name: body.name }),
    ...(differs(body.prompt, initial.prompt) && { prompt: body.prompt }),
    ...(differs(body.enabled, initial.enabled) && { enabled: body.enabled }),
    ...(access && {
      readOnly: body.readOnly,
      mcpServers: body.mcpServers,
      workspace: body.workspace,
    }),
    ...(differs(body.model, initial.model) && { model: body.model }),
    ...(differs(body.schedule, initial.schedule) && { schedule: body.schedule }),
    ...(differs(body.timeZone, initial.timeZone) && { timeZone: body.timeZone }),
    ...(differs(body.runAt, initial.runAt) && { runAt: body.runAt }),
  };
}

const McpNames = Schema.Struct({
  mcpServers: Schema.Array(Schema.Struct({ name: Schema.String })),
});

function AutomationForm({
  automation,
  onClose,
  onSaved,
}: {
  automation?: Automation;
  onClose: () => void;
  onSaved: () => void;
}) {
  /** The automation as the form opened it: its values and the access an edit is made against. */
  const [opened] = useState(automation);
  const [initial] = useState(() => initialValues(opened));
  const [name, setName] = useState(initial.name);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [when, setWhen] = useState<When>(initial.when);
  const [schedule, setSchedule] = useState(initial.schedule);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [runAt, setRunAt] = useState(initial.runAt);
  const [repository, setRepository] = useState(initial.repository);
  const [ref, setRef] = useState(initial.ref);
  const [readOnly, setReadOnly] = useState(initial.readOnly);
  const [model, setModel] = useState(initial.model);
  const [mcpServers, setMcpServers] = useState(initial.mcpServers);
  const [available, setAvailable] = useState<readonly string[]>([]);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    request("/connections", undefined, controller.signal)
      .then((text) =>
        setAvailable(
          Schema.decodeUnknownSync(Schema.fromJsonString(McpNames))(text).mcpServers.map(
            (server) => server.name,
          ),
        ),
      )
      .catch(() => {});

    return () => controller.abort();
  }, []);

  const preset = SCHEDULE_PRESETS.some((item) => item.schedule === schedule) ? schedule : "custom";

  async function save(event: FormEvent) {
    event.preventDefault();

    const built = bodyOf({
      name,
      prompt,
      when,
      schedule,
      timeZone,
      runAt,
      repository,
      ref,
      readOnly,
      model,
      mcpServers,
      enabled,
    });

    if ("error" in built) {
      setError(built.error);

      return;
    }

    const before = automation && bodyOf(initial);
    const patch = before && !("error" in before) ? patchOf(built.body, before.body) : built.body;

    // An access change is made against the access shown: the server refuses it if another
    // tab or the API changed that since, rather than undo (say) a switch to read-only.
    const body =
      opened && patch.readOnly !== undefined
        ? {
            ...patch,
            // From the same snapshot as the form's values, never a fresher prop: stale values
            // paired with current access would pass the server's check.
            accessWas: {
              readOnly: opened.readOnly,
              mcpServers: opened.mcpServers,
              repository: opened.workspace?.repository ?? null,
              ref: opened.workspace?.ref ?? null,
            },
          }
        : patch;

    // Nothing changed: an empty patch is not a request the API accepts.
    if (automation && Object.keys(body).length === 0) {
      onClose();

      return;
    }

    setSaving(true);
    setError("");

    try {
      await saveAutomation(automation?.id, body);
      onSaved();
    } catch (cause) {
      setError(message(cause, "Could not save the automation."));
      setSaving(false);
    }
  }

  return (
    <form className="settings-card automation-form" onSubmit={(event) => void save(event)}>
      <h2 className="settings-step">{automation ? `Edit ${automation.name}` : "New automation"}</h2>
      <label htmlFor="automation-name">Name</label>
      <Input
        id="automation-name"
        value={name}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
        placeholder="Stale PR monitor"
      />
      <label htmlFor="automation-prompt">Prompt</label>
      <Textarea
        id="automation-prompt"
        rows={6}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="List the open pull requests with no activity for a week, most stuck first. Don't comment on them."
      />

      <fieldset className="automation-when">
        <legend>When it runs</legend>
        {(
          [
            ["schedule", "On a schedule"],
            ["once", "Once"],
            ["manual", "Only when I press Run"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="checkbox-row">
            <input
              type="radio"
              name="automation-when"
              value={value}
              checked={when === value}
              onChange={() => setWhen(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      {when === "schedule" && (
        <div className="mcp-form-row">
          <div>
            <label htmlFor="automation-preset">Schedule</label>
            <Select
              id="automation-preset"
              value={preset}
              onChange={(event) => {
                if (event.target.value !== "custom") setSchedule(event.target.value);
              }}
            >
              {SCHEDULE_PRESETS.map((item) => (
                <option key={item.schedule} value={item.schedule}>
                  {item.label}
                </option>
              ))}
              <option value="custom">Custom (cron)</option>
            </Select>
            <Input
              id="automation-cron"
              aria-label="Cron expression"
              className="mono"
              spellCheck={false}
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
            />
            <p className="field-help">
              Minute, hour, day of month, month, day of week. At most every 10 minutes.
            </p>
          </div>
          <div>
            <label htmlFor="automation-zone">Time zone</label>
            <Input
              id="automation-zone"
              spellCheck={false}
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              placeholder="Europe/Paris"
            />
          </div>
        </div>
      )}

      {when === "once" && (
        <>
          <label htmlFor="automation-at">Run at</label>
          <Input
            id="automation-at"
            type="datetime-local"
            value={runAt}
            onChange={(event) => setRunAt(event.target.value)}
          />
        </>
      )}

      <label htmlFor="repository">Repository</label>
      <RepositoryPicker
        compact
        value={repository}
        onChange={(next, defaultRef) => {
          setRepository(next);
          // Back on the automation's own repository: its own branch, not the last one picked.
          setRef(
            next === automation?.workspace?.repository
              ? (automation.workspace.ref ?? "")
              : next
                ? defaultRef
                : "",
          );
        }}
      />
      {repository && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
          />
          Read-only: read code and report, never change the repository
        </label>
      )}

      <label htmlFor="automation-model">Model</label>
      <ModelPicker id="automation-model" value={model} onChange={setModel} />

      {!readOnly && (
        <fieldset className="automation-mcp">
          <legend>MCP servers runs may use</legend>
          {available.length === 0 ? (
            <p className="field-help">No MCP servers connected. Add them in Connections.</p>
          ) : (
            available.map((server) => (
              <label key={server} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={mcpServers.includes(server)}
                  onChange={(event) =>
                    setMcpServers(
                      event.target.checked
                        ? [...mcpServers, server]
                        : mcpServers.filter((item) => item !== server),
                    )
                  }
                />
                {displayName(server)}
              </label>
            ))
          )}
          <p className="field-help">
            None unless ticked: they act with your credentials, and nobody watches a run live.
          </p>
        </fieldset>
      )}

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enabled
      </label>

      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button
          type="submit"
          className="primary-button"
          disabled={saving || !name.trim() || !prompt.trim()}
        >
          {saving ? "Saving…" : automation ? "Save" : "Create automation"}
        </button>
      </div>
    </form>
  );
}
