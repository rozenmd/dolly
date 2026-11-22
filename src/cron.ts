/**
 * Five-field cron schedules (minute hour day-of-month month day-of-week) evaluated in an IANA
 * time zone, for automations (automations.ts). Supports `*`, numbers, ranges `a-b`, steps `* /n`
 * and `a-b/n`, lists, month and weekday names, and 7 as Sunday. As in Vixie cron, when both
 * day-of-month and day-of-week are restricted a day matching either one fires.
 *
 * Wall times skipped by a daylight-saving jump do not fire; a wall time repeated when clocks go
 * back fires once, at its first occurrence.
 */

export type Cron = {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Whether the day-of-month and day-of-week fields were each restricted (not starting `*`). */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type Field = { name: string; min: number; max: number; names?: string[]; nameBase?: number };

const MINUTE: Field = { name: "minute", min: 0, max: 59 };
const HOUR: Field = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: Field = { name: "day of month", min: 1, max: 31 };
const MONTH: Field = { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 };
const WEEKDAY: Field = { name: "day of week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 };

function value(text: string, field: Field) {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;

  if (named >= 0) return named + (field.nameBase ?? 0);

  if (!/^\d{1,2}$/.test(text)) return undefined;
  const number = Number(text);

  return number >= field.min && number <= field.max ? number : undefined;
}

function parseField(text: string, field: Field): { values: Set<number> } | { error: string } {
  const values = new Set<number>();

  for (const part of text.split(",")) {
    const [range = "", stepText, extra] = part.split("/");

    if (extra !== undefined) return { error: `Invalid ${field.name} "${part}"` };
    let step = 1;

    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1)
        return { error: `Invalid step in ${field.name} "${part}"` };
      step = Number(stepText);
    }

    let from: number | undefined;
    let to: number | undefined;

    if (range === "*") {
      from = field.min;
      to = field.max;
    } else {
      const [start = "", end, more] = range.split("-");

      if (more !== undefined) return { error: `Invalid ${field.name} "${part}"` };
      from = value(start, field);
      // A step on a single value runs to the end of the field, as in Vixie cron.
      to = end === undefined ? (stepText === undefined ? from : field.max) : value(end, field);
    }

    if (from === undefined || to === undefined || from > to)
      return { error: `Invalid ${field.name} "${part}" (allowed ${field.min}-${field.max})` };

    for (let current = from; current <= to; current += step) values.add(current);
  }

  return { values };
}

/** Parse a five-field expression, or describe what is wrong with it. */
export function parseCron(expression: string): Cron | { error: string } {
  const parts = expression.trim().split(/\s+/);

  if (parts.length !== 5)
    return {
      error: "A schedule has five fields: minute hour day-of-month month day-of-week",
    };

  const [minuteText = "", hourText = "", dayText = "", monthText = "", weekdayText = ""] = parts;
  const minutes = parseField(minuteText, MINUTE);

  if ("error" in minutes) return minutes;
  const hours = parseField(hourText, HOUR);

  if ("error" in hours) return hours;
  const days = parseField(dayText, DAY_OF_MONTH);

  if ("error" in days) return days;
  const months = parseField(monthText, MONTH);

  if ("error" in months) return months;
  const weekdays = parseField(weekdayText, WEEKDAY);

  if ("error" in weekdays) return weekdays;

  if (weekdays.values.delete(7)) weekdays.values.add(0);

  return {
    minutes: minutes.values,
    hours: hours.values,
    days: days.values,
    months: months.values,
    weekdays: weekdays.values,
    // As in Vixie cron, a field starting with `*` (also `*/2`) counts as unrestricted.
    daysRestricted: !dayText.startsWith("*"),
    weekdaysRestricted: !weekdayText.startsWith("*"),
  };
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });

    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of `instant` in `timeZone`. */
function wall(instant: number, timeZone: string) {
  let format = formatters.get(timeZone);

  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, format);
  }

  const fields: Record<string, number> = {};

  for (const part of format.formatToParts(instant))
    if (part.type !== "literal") fields[part.type] = Number(part.value);

  return {
    year: fields.year ?? 0,
    month: fields.month ?? 1,
    day: fields.day ?? 1,
    hour: fields.hour ?? 0,
    minute: fields.minute ?? 0,
  };
}

/** The wall time of `instant` in `timeZone`, written as if it were UTC. */
function wallAsUtc(instant: number, timeZone: string) {
  const fields = wall(instant, timeZone);

  return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
}

/** The first instant whose wall time in `timeZone` is `local` (a wall time written as UTC). */
function instantOf(local: number, timeZone: string) {
  // Two refinements settle the zone offset; then prefer an earlier instant with the same wall time.
  const first = local - (wallAsUtc(local, timeZone) - local);
  const instant = local - (wallAsUtc(first, timeZone) - first);

  if (wallAsUtc(instant, timeZone) !== local) return undefined;

  const earlier = instant - 3_600_000;

  return wallAsUtc(earlier, timeZone) === local ? earlier : instant;
}

const DAY = 86_400_000;

/** How far ahead to look: a leap day on a Monday can be years away, but not more than this. */
const SEARCH_DAYS = 366 * 8;

/** The first time strictly after `after` the schedule fires in `timeZone`, if any within years. */
export function nextCronTime(cron: Cron, after: number, timeZone = "UTC"): number | undefined {
  const start = wall(after, timeZone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const startLocal = startDay + (start.hour * 60 + start.minute) * 60_000;
  const hours = [...cron.hours].sort((a, b) => a - b);
  const minutes = [...cron.minutes].sort((a, b) => a - b);

  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const day = startDay + offset * DAY;
    const date = new Date(day);

    if (!cron.months.has(date.getUTCMonth() + 1)) continue;
    const dayMatch = cron.days.has(date.getUTCDate());
    const weekdayMatch = cron.weekdays.has(date.getUTCDay());

    const matches =
      cron.daysRestricted && cron.weekdaysRestricted
        ? dayMatch || weekdayMatch
        : dayMatch && weekdayMatch;

    if (!matches) continue;

    for (const hour of hours)
      for (const minute of minutes) {
        const local = day + hour * 3_600_000 + minute * 60_000;

        // Wall times well before the start cannot come after it; only a repeated hour can.
        if (local < startLocal - 3 * 3_600_000) continue;
        const instant = timeZone === "UTC" ? local : instantOf(local, timeZone);

        if (instant !== undefined && instant > after) return instant;
      }
  }

  return undefined;
}

/**
 * The shortest gap between the next `count` firings after `after`, in milliseconds; undefined
 * when it fires fewer than twice in that window.
 */
export function shortestInterval(cron: Cron, after: number, timeZone = "UTC", count = 48) {
  let previous = nextCronTime(cron, after, timeZone);
  let shortest: number | undefined;

  for (let index = 1; index < count && previous !== undefined; index++) {
    const next = nextCronTime(cron, previous, timeZone);

    if (next === undefined) break;
    shortest = Math.min(shortest ?? Infinity, next - previous);
    previous = next;
  }

  return shortest;
}
