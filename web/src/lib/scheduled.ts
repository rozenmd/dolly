import * as Schema from "effect/Schema";
import { request } from "./api";

export { parseScheduledMessage } from "../../../src/schedule-message";

export const ScheduledPrompt = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  prompt: Schema.String,
  source: Schema.Literals(["agent", "owner"]),
});

export type ScheduledPrompt = typeof ScheduledPrompt.Type;

const ScheduledList = Schema.Struct({ scheduled: Schema.Array(ScheduledPrompt) });

const path = (session: string) => `/sessions/${encodeURIComponent(session)}/scheduled`;

/** The session's pending scheduled prompts, soonest first. */
export async function scheduledPrompts(session: string, signal?: AbortSignal) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(ScheduledList))(
    await request(path(session), undefined, signal),
  ).scheduled;
}

/** Sends `content` to the session at `at`, as if the owner typed it then. */
export async function schedulePrompt(
  session: string,
  input: { content: string; at: Date; requestId: string },
) {
  await request(path(session), {
    content: input.content,
    at: input.at.toISOString(),
    requestId: input.requestId,
  });
}

export async function cancelScheduledPrompt(session: string, id: string) {
  await request(`${path(session)}/${encodeURIComponent(id)}`, undefined, undefined, "DELETE");
}

/** "in 45m", "in 3h", "in 2d": a short countdown to a future time. */
export function untilLabel(at: number, now: number) {
  const ms = at - now;

  if (ms <= 0) return "now";

  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;

  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;

  return `in ${Math.round(ms / 86_400_000)}d`;
}

const time = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Slack-style quick picks: later today, tomorrow morning and next Monday morning, local time,
 * keeping only those still ahead and within the server's 7-day limit.
 */
export function quickPicks(now: Date) {
  const picks: { label: string; at: Date }[] = [];
  const limit = now.getTime() + 7 * 86_400_000;

  const add = (label: string, at: Date) => {
    if (
      at.getTime() > now.getTime() + 60_000 &&
      at.getTime() <= limit &&
      !picks.some((pick) => pick.at.getTime() === at.getTime())
    )
      picks.push({ label, at });
  };

  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  add(`Today at ${time(evening)}`, evening);

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  add(`Tomorrow at ${time(tomorrow)}`, tomorrow);

  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  add(`${monday.toLocaleDateString([], { weekday: "long" })} at ${time(monday)}`, monday);

  return picks;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A local date as an `<input type="date">` value. */
export function dateInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
