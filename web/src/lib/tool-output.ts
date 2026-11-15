/**
 * Presentation for tool results. Tools return JSON for the model, which reads
 * badly as a wall of escaped text, so the transcript renders the meaningful
 * parts: a command's stdout and stderr, a file's content, or a readable outline
 * of other results. The model's copy is never changed.
 */
import { Option, Schema } from "effect";

export type OutputSection = { kind: "stdout" | "stderr" | "text"; text: string };

export type ToolOutput = {
  sections: OutputSection[];
  /** Non-zero exit status of a command, shown beside the step name. */
  exitCode?: number;
  /** The tool reported a failure in its own result envelope. */
  failed?: boolean;
};

const JsonText = Schema.fromJsonString(Schema.Json);

const CommandResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.optional(Schema.Number),
});

const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
});

const Success = Schema.Struct({ ok: Schema.Literal(true), result: Schema.Json });
const FileResult = Schema.Struct({ content: Schema.String });
const Listing = Schema.Struct({ kind: Schema.String, data: Schema.Json });

const isString = Schema.is(Schema.String);
const isObject = Schema.is(Schema.JsonObject);

function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: Schema.Json,
) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
}

/** Keys that only exist for the model or bookkeeping and add noise to a transcript. */
const HIDDEN = new Set(["workspaceSetup", "sha"]);

/** A YAML-like outline: multi-line strings keep their line breaks instead of `\n` escapes. */
export function outline(value: Schema.Json, indent = ""): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}[]`;

    return value
      .map((item: Schema.Json) =>
        Array.isArray(item) || isObject(item)
          ? `${indent}- ${outline(item, `${indent}  `).trimStart()}`
          : `${indent}- ${blockString(item, `${indent}  `)}`,
      )
      .join("\n");
  }

  if (isObject(value)) {
    const entries = Object.entries(value).filter(([key]) => !HIDDEN.has(key));

    if (entries.length === 0) return `${indent}{}`;

    return entries
      .map(([key, item]) =>
        (Array.isArray(item) && item.length) || (isObject(item) && Object.keys(item).length)
          ? `${indent}${key}:\n${outline(item, `${indent}  `)}`
          : `${indent}${key}: ${blockString(item, `${indent}  `)}`,
      )
      .join("\n");
  }

  return `${indent}${blockString(value, indent)}`;
}

function blockString(value: Schema.Json, indent: string): string {
  if (!isString(value)) return JSON.stringify(value);

  if (!value.includes("\n")) return value;

  return `|\n${value
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n")}`;
}

function section(kind: OutputSection["kind"], value: string): OutputSection[] {
  const trimmed = value.replace(/\n+$/, "");

  return trimmed ? [{ kind, text: trimmed }] : [];
}

/** Formats a tool result for display. Text that is not JSON is shown as-is. */
export function formatToolOutput(raw: string): ToolOutput {
  const trimmed = raw.trim();

  const value =
    trimmed.startsWith("{") || trimmed.startsWith("[") ? decode(JsonText, trimmed) : undefined;

  if (value === undefined) return { sections: section("text", raw) };

  const command = decode(CommandResult, value);

  if (command) {
    const output: ToolOutput = {
      sections: [...section("stdout", command.stdout), ...section("stderr", command.stderr)],
    };

    if (command.exitCode) output.exitCode = command.exitCode;

    return output;
  }

  const failure = decode(Failure, value);

  if (failure) {
    const message = failure.message ?? outline(value);

    return {
      sections: section("stderr", failure.code ? `${failure.code}: ${message}` : message),
      failed: true,
    };
  }

  const success = decode(Success, value);

  if (success) {
    // A file read shows the file, not its envelope.
    const file = decode(FileResult, success.result);

    if (file) return { sections: section("text", file.content) };

    const listing = decode(Listing, success.result);

    return { sections: section("text", outline(listing ? listing.data : success.result)) };
  }

  return { sections: section("text", outline(value)) };
}

/** A command or argument on one line, so a multi-line script still fits a row. */
export function oneLine(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ⏎ ");
}
