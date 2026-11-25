import type { EntryRecord } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What a child session actually did, computed by Dolly from its transcript instead of summarized
 * by the child. A child reports back in prose, which is the right carrier for judgement (did this
 * meet the bar, what is still uncertain) and the wrong one for facts: the first thing a summary
 * drops is what was tried and failed. The transcript already holds the facts, so they are attached
 * to the report mechanically, and the child is asked only for what can't be computed.
 *
 * Honesty about what is known: a failed tool call sets `isError`, and the shell tool reports its
 * exit code, so failures listed here are ones a tool reported. Nothing here claims a check passed.
 */

type PiMessage = NonNullable<EntryRecord["model"]>[number];

/** The arguments of Dolly's tools that say what a call did; other fields are ignored. */
const CallArgs = Schema.Struct({
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  operation: Schema.optional(Schema.Struct({ action: Schema.optional(Schema.String) })),
});

type Call = { name: string; args: typeof CallArgs.Type };

/** The shell tool's JSON result. */
const ShellResult = Schema.fromJsonString(
  Schema.Struct({
    exitCode: Schema.Number,
    stdout: Schema.optional(Schema.String),
    stderr: Schema.optional(Schema.String),
  }),
);

export type ChildFailure = {
  tool: string;
  what: string;
  error: string;
  /** The same call ran again later without failing. */
  laterPassed: boolean;
};

export type ChildEvidence = {
  files: string[];
  commands: string[];
  failures: ChildFailure[];
  /** Commits, pushes and pull requests, in order. */
  shipped: string[];
  toolCalls: number;
};

const MAX_FILES = 20;
const MAX_COMMANDS = 12;
const MAX_FAILURES = 5;
const ERROR_HEAD = 200;
const ERROR_TAIL = 400;

/** The evidence block's ceiling: a report must inform the parent, not refill its context. */
export const EVIDENCE_MAX_CHARS = 4_000;

const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** Both ends of an error: the first line says what failed, the last the verdict. */
export function clipError(body: string) {
  const text = body.replace(/\s+/g, " ").trim();

  if (text.length <= ERROR_HEAD + ERROR_TAIL) return text;

  return `${text.slice(0, ERROR_HEAD)} … ${text.slice(-ERROR_TAIL)}`;
}

/** The part of a command worth listing: drop `cd … &&` preambles, keep the program and its first argument. */
export function commandHead(command: string) {
  let text = command.replace(/\s+/g, " ").trim();
  text = text.replace(/^(cd\s+\S+\s*&&\s*)+/i, "");
  text = text.split(/\s*(?:\||;|&&)\s*/)[0] || text;

  return text.split(" ").filter(Boolean).slice(0, 2).join(" ").slice(0, 60);
}

function resultText(message: PiMessage & { role: "toolResult" }) {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** A shell result's exit code and the output worth quoting when it failed. */
function shellOutcome(text: string) {
  // Restore notices may precede the JSON result.
  const parsed = Schema.decodeUnknownOption(ShellResult)(text.slice(text.indexOf("{")));

  if (Option.isSome(parsed))
    return {
      exitCode: parsed.value.exitCode,
      output: parsed.value.stderr?.trim() || parsed.value.stdout || "",
    };

  const code = /"exitCode":\s*(-?\d+)/.exec(text);

  return { exitCode: code ? Number(code[1]) : undefined, output: text };
}

/** What a call was doing, for the failure list. */
function subject(call: Call | undefined) {
  if (!call) return "";

  const args = call.args;

  for (const value of [
    args.command,
    args.path,
    args.action,
    args.operation?.action,
    args.url,
    args.pattern,
  ]) {
    const text = value?.trim();

    if (text) return text.replace(/\s+/g, " ").slice(0, 200);
  }

  return "";
}

/** Evidence from the messages of a span of a child's transcript, oldest first. */
export function childEvidence(entries: readonly EntryRecord[]): ChildEvidence {
  const calls = new Map<string, Call>();
  const files = new Set<string>();
  const commands = new Set<string>();
  const failures: ChildFailure[] = [];
  const shipped: string[] = [];
  let toolCalls = 0;

  const messages = entries.flatMap((entry) => entry.model ?? []);

  for (const message of messages) {
    if (message.role === "assistant")
      for (const block of message.content)
        if (block.type === "toolCall") {
          calls.set(block.id, {
            name: block.name,
            args: Option.getOrElse(
              Schema.decodeUnknownOption(CallArgs)(block.arguments),
              () => ({}),
            ),
          });
          toolCalls += 1;
        }

    if (message.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    const name = call?.name ?? message.toolName;
    const what = subject(call);
    const text = resultText(message);
    let failed: string | undefined;

    if (name === "shell") {
      const command = call?.args.command;

      if (command) {
        const head = commandHead(command);

        if (head) commands.add(head);
      }
    }

    // Shell commands and the workspace's git actions report a command's exit code as output.
    const outcome =
      name === "shell" || name === "workspace"
        ? shellOutcome(text)
        : { exitCode: undefined, output: "" };

    if (message.isError) failed = clipError(text);
    else if (outcome.exitCode !== undefined && outcome.exitCode !== 0)
      failed = `exited ${outcome.exitCode}: ${clipError(outcome.output)}`;

    // A call that failed and later ran the same way without failing.
    if (!failed) {
      for (const failure of failures)
        if (failure.tool === name && failure.what === what) failure.laterPassed = true;
    } else failures.push({ tool: name, what, error: failed, laterPassed: false });

    if (failed) continue;
    const path = call?.args.path;

    if ((name === "write_file" || name === "edit_file") && path) files.add(path);

    const action = call?.args.action;
    const summary = call?.args.message?.split("\n")[0]?.slice(0, 80);

    if (name === "workspace" && (action === "commit" || action === "push"))
      shipped.push(action === "commit" && summary ? `commit "${summary}"` : action);

    if ((name === "github" || name === "workspace") && text.includes('"pull_request"')) {
      const url = PULL_URL.exec(text)?.[0];

      if (url && !shipped.includes(`pull request ${url}`)) shipped.push(`pull request ${url}`);
    }
  }

  // Unresolved failures first: they are what the parent most needs to see.
  const ordered = [
    ...failures.filter((failure) => !failure.laterPassed),
    ...failures.filter((failure) => failure.laterPassed),
  ];

  return {
    files: [...files],
    commands: [...commands],
    failures: ordered,
    shipped,
    toolCalls,
  };
}

const list = (items: readonly string[], max: number) =>
  items.length > max
    ? `${items.slice(0, max).join(", ")} (+${items.length - max} more)`
    : items.join(", ");

/** The evidence block of a report, one fact per line, within `EVIDENCE_MAX_CHARS`. */
export function formatChildEvidence(
  evidence: ChildEvidence,
  where: { repository?: string; branch?: string },
) {
  const lines: string[] = [];

  if (where.branch)
    lines.push(`- Branch: ${where.branch}${where.repository ? ` in ${where.repository}` : ""}`);
  else lines.push("- No repository checkout");

  lines.push(
    `- Files written: ${evidence.files.length ? list(evidence.files, MAX_FILES) : "none"}`,
    `- Commands run: ${evidence.commands.length ? list(evidence.commands, MAX_COMMANDS) : "none"}`,
  );

  const shown = evidence.failures.slice(0, MAX_FAILURES);

  if (shown.length) {
    lines.push(`- Failures a tool reported (${evidence.failures.length}):`);

    for (const failure of shown)
      lines.push(
        `  - ${failure.tool}${failure.what ? ` \`${failure.what}\`` : ""}${failure.laterPassed ? " (a later identical call succeeded)" : ""}: ${failure.error}`,
      );

    if (evidence.failures.length > shown.length)
      lines.push(`  - +${evidence.failures.length - shown.length} more`);
  } else lines.push("- Failures a tool reported: none");

  lines.push(
    `- Commits, pushes and pull requests: ${evidence.shipped.length ? evidence.shipped.join("; ") : "none"}`,
    `- Tool calls: ${evidence.toolCalls}`,
  );

  const text = lines.join("\n");

  return text.length > EVIDENCE_MAX_CHARS ? `${text.slice(0, EVIDENCE_MAX_CHARS - 1)}…` : text;
}

/** The text of the last assistant message in a span that has any. */
export function lastReply(entries: readonly EntryRecord[]) {
  const messages = entries.flatMap((entry) => entry.model ?? []);

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message?.role !== "assistant") continue;

    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");

    if (text.trim()) return text.trim();
  }

  return "";
}

/** The end of a long text, saying how much came before it. */
export function tail(text: string, max: number) {
  if (text.length <= max) return text;

  return `[… ${text.length - max} earlier characters omitted …]\n${text.slice(-max)}`;
}

/** Appended to a child's first message: what it is, and that its final reply is its report. */
export function workerBriefing(input: { repository?: string; branch?: string }) {
  const where = input.branch
    ? `You work in your own sandbox, on branch ${input.branch}${input.repository ? ` of ${input.repository}` : ""}, checked out fresh: you can't see the parent's unpushed changes.`
    : "You work in your own sandbox.";

  return [
    "---",
    `You are a child session that another Dolly session (your parent) started for the task above. Keep to it: do the requested investigation or change, run relevant checks when practical, and don't widen the scope or make product or taste decisions unless asked. ${where} Later messages in this session may be follow-ups from that parent session.`,
    "Your final reply is your report. Dolly sends it to the parent session automatically when your turn ends and none of your own child sessions are still working, so don't message the parent yourself. Facts are attached to it from your transcript (files written, commands run, failures a tool reported, commits, pushes and pull requests), so don't list them. Write what can't be computed: whether the result meets the task's acceptance criteria and how sure you are, what you tried that didn't work and why you dropped it, assumptions you made, what's still uncertain, and follow-ups needed.",
  ].join("\n\n");
}
