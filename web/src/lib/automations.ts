import * as Schema from "effect/Schema";
import { request, type ApiBody } from "./api";

/** Settings > Automations: the API in src/automation-routes.ts, behaviour in src/automations.ts. */

export const AutomationRun = Schema.Struct({
  trigger: Schema.Literals(["schedule", "manual", "webhook"]),
  at: Schema.Number,
  status: Schema.Literals(["running", "succeeded", "failed", "skipped"]),
  sessionId: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.Number),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export type AutomationRun = typeof AutomationRun.Type;

export const Automation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schema.optional(Schema.String),
  timeZone: Schema.optional(Schema.String),
  runAt: Schema.optional(Schema.Number),
  enabled: Schema.Boolean,
  readOnly: Schema.Boolean,
  workspace: Schema.optional(
    Schema.Struct({
      repository: Schema.String,
      ref: Schema.optional(Schema.String),
      networkHosts: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  model: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
  mcpServers: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  nextRunAt: Schema.optional(Schema.Number),
  /** The secret webhook path on the ingress Worker, when the automation has one. */
  webhookPath: Schema.optional(Schema.String),
  runs: Schema.Array(AutomationRun),
});

export type Automation = typeof Automation.Type;

const AutomationList = Schema.Struct({ automations: Schema.Array(Automation) });

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Automation));

const path = (id: string) => `/automations/${encodeURIComponent(id)}`;

export async function listAutomations(signal?: AbortSignal) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(AutomationList))(
    await request("/automations", undefined, signal),
  ).automations;
}

/** Creates an automation, or saves changes to one; `null` fields are cleared. */
export async function saveAutomation(id: string | undefined, body: ApiBody) {
  return decode(
    id === undefined
      ? await request("/automations", body, undefined, "POST")
      : await request(path(id), body, undefined, "PUT"),
  );
}

export async function deleteAutomation(id: string) {
  await request(path(id), undefined, undefined, "DELETE");
}

/** Starts a run now; resolves to its session. */
export async function runAutomation(id: string) {
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ sessionId: Schema.optional(Schema.String) })),
  )(await request(`${path(id)}/run`, { requestId: crypto.randomUUID() }, undefined, "POST"));
}

/** Common schedules, offered before a custom cron expression. */
export const SCHEDULE_PRESETS = [
  { schedule: "0 * * * *", label: "Every hour" },
  { schedule: "0 9 * * *", label: "Every day at 09:00" },
  { schedule: "0 9 * * 1-5", label: "Weekdays at 09:00" },
  { schedule: "0 9 * * 1", label: "Mondays at 09:00" },
  { schedule: "0 0 1 * *", label: "First of the month at 00:00" },
] as const;

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const pad = (value: string) => value.padStart(2, "0");

/** A plain-words reading of the common cron shapes; anything else shows the expression itself. */
export function describeSchedule(schedule: string) {
  const preset = SCHEDULE_PRESETS.find((item) => item.schedule === schedule);

  if (preset) return preset.label;
  const [minute = "", hour = "", day = "", month = "", weekday = ""] = schedule.trim().split(/\s+/);
  const numeric = (value: string) => /^\d{1,2}$/.test(value);

  if (!numeric(minute) || month !== "*") return `Cron ${schedule}`;

  if (hour === "*" && day === "*" && weekday === "*")
    return minute === "0" ? "Every hour" : `Every hour at :${pad(minute)}`;

  if (!numeric(hour)) return `Cron ${schedule}`;
  const time = `${pad(hour)}:${pad(minute)}`;

  if (day === "*" && weekday === "*") return `Every day at ${time}`;

  if (day === "*" && weekday === "1-5") return `Weekdays at ${time}`;

  if (day === "*" && /^[0-7]$/.test(weekday)) return `${DAYS[Number(weekday) % 7]} at ${time}`;

  if (numeric(day) && weekday === "*") return `Day ${day} of each month at ${time}`;

  return `Cron ${schedule}`;
}

/** The browser's IANA time zone, the default for new schedules. */
export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const two = (value: number) => String(value).padStart(2, "0");

/** A local date and time as `<input type="datetime-local">` reads and writes them. */
export function dateTimeInput(date: Date) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** "Fri 21 Nov, 09:00": a short local date and time. */
export function shortDateTime(at: number) {
  return new Date(at).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Replaces an automation's webhook URL with a new secret; the old URL stops working. */
export async function rotateWebhook(id: string) {
  // One save: revoking and re-adding could leave no URL if the second request were lost.
  return saveAutomation(id, { webhook: "rotate" });
}

/** The ingress Worker's origin from its GitHub hook URL, or the workers.dev guess. */
export function ingressOrigin(ingress: string | null | undefined, guess: string) {
  if (!ingress) return guess;

  try {
    return new URL(ingress).origin;
  } catch {
    return guess;
  }
}
