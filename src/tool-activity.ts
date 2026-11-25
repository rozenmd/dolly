/**
 * How a tool call reads to a person, shared by the transcript (web/src/lib/api.ts), thread cards
 * and the session list's `activity` (session-activity.ts), so they all word a step the same way.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A tool call as a transcript block carries it. */
export type ToolCall = { name?: string | undefined; arguments?: unknown };

/** A step's recognisable arguments, and the file it reads or writes, if any. */
export type StepDetail = { detail: string; file?: { prefix: string; path: string } };

const ToolArguments = Schema.Struct({
  action: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const ScheduleArguments = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  in_minutes: Schema.optional(Schema.Number),
  at: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

/** When a schedule_prompt call fires, then what it says: `in 2h · Start the migration…`. */
function scheduleDetail(block: ToolCall) {
  const args = Option.getOrUndefined(
    Schema.decodeUnknownOption(ScheduleArguments)(block.arguments),
  );

  if (!args) return "";

  if (block.name === "cancel_scheduled_prompt") return args.id ?? "";

  const minutes = args.in_minutes;

  const when =
    minutes === undefined
      ? args.at
      : minutes < 60 || minutes % 60
        ? `in ${minutes}m`
        : `in ${minutes / 60}h`;

  return [when, args.prompt].filter(Boolean).join(" · ");
}

const WaitArguments = Schema.Struct({
  repository: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number),
  run_id: Schema.optional(Schema.Number),
  workflow: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
});

/** What a wait_for call watches: `owner/repo#12` or `owner/repo release.yml @ v1.2.0`. */
function waitDetail(block: ToolCall) {
  const args = Option.getOrUndefined(Schema.decodeUnknownOption(WaitArguments)(block.arguments));

  if (!args?.repository) return "";

  if (args.number !== undefined) return `${args.repository}#${args.number}`;

  if (args.run_id !== undefined) return `${args.repository} run ${args.run_id}`;

  return [args.repository, args.workflow, args.ref && `@ ${args.ref}`].filter(Boolean).join(" ");
}

const OperationArguments = Schema.Struct({ operation: Schema.Unknown });

/**
 * The most recognisable arguments of a tool call, such as its command or file
 * path, prefixed by the action for multi-action tools (`checkout owner/repo`).
 */
function stepArguments(block: ToolCall) {
  const nested = Option.getOrUndefined(
    Schema.decodeUnknownOption(OperationArguments)(block.arguments),
  );

  const args = Option.getOrUndefined(
    Schema.decodeUnknownOption(ToolArguments)(nested?.operation ?? block.arguments),
  );

  return args;
}

export function stepDetail(block: ToolCall): StepDetail {
  if (block.name === "schedule_prompt" || block.name === "cancel_scheduled_prompt")
    return { detail: scheduleDetail(block) };

  if (block.name === "wait_for") return { detail: waitDetail(block) };

  const args = stepArguments(block);

  if (!args) return { detail: "" };

  const target =
    args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url;

  const prefix = [args.action, args.repository].filter(Boolean).join(" ");
  const detail = [prefix, target].filter(Boolean).join(" ");
  const path = args.file_path ?? args.path;

  // Preview's `path` is a URL path, not a file.
  return args.command === undefined && path && block.name !== "preview"
    ? { detail, file: { prefix, path } }
    : { detail };
}

type StepLike = { name: string; detail: string; file?: { path: string } | undefined };

const basename = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One tool call as a step a person would name: "Editing checkout.tsx", "Running pnpm test". */
export function stepSummary(step: StepLike): string {
  const file = step.file && basename(step.file.path);
  const detail = clip(step.detail.split("\n")[0]?.trim() ?? "", 80);

  switch (step.name) {
    case "edit_file":
    case "edit":
      return file ? `Editing ${file}` : "Editing a file";
    case "write_file":
    case "write":
      return file ? `Writing ${file}` : "Writing a file";
    case "read_file":
      return file ? `Reading ${file}` : "Reading a file";
    case "shell":
    case "bash":
      return detail ? `Running ${detail}` : "Running a command";
    case "preview":
      return "Previewing the app";
    case "spawn_task":
      return "Starting a thread";
    case "send_to_session":
      return "Messaging a session";
    case "wait_for":
      return detail ? `Waiting on ${detail}` : "Waiting";
    case "web_fetch":
      return "Reading the web";
    default:
      return detail ? `${step.name} ${detail}` : `Using ${step.name}`;
  }
}
