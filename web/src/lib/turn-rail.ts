import type { PromptIndex } from "../../../src/transcript";
import { parseScheduledMessage } from "../../../src/schedule-message";
import { parseCiWaitMessage } from "../../../src/ci-wait-message";
import { parseChildReportMessage } from "../../../src/child-report-message";
import type { Step, Turn } from "./api";

/**
 * The prompts sent in a session, in order: the index behind the conversation's turn rail
 * (components/turn-rail.tsx), after opensession's message rail.
 *
 * Each prompt also carries what came of it, the agent's answer and what the turn produced, because someone
 * scrolling back is recognising a moment, and the moment is the question plus its answer.
 */

/** What a turn produced, when its tool calls say so plainly. */
export type RailOutcome = { kind: "pr" | "commit" | "edit"; label: string };

/** One mark on the rail. */
export type RailMark = {
  /** The turn's id, also its `data-turn` in the conversation. */
  id: string;
  /** The prompt, flattened to one line. */
  preview: string;
  /** The turn's answer, or how it is going, flattened. */
  reply?: string;
  outcome?: RailOutcome;
  at?: number;
};

/** Enough for the card's two lines; clamped here too so a pasted log doesn't ride into it whole. */
const MAX_PREVIEW = 120;
const MAX_REPLY = 260;

/** Answers run long; the preview only ever comes from their opening. */
const REPLY_SCAN = 1200;

const OUTCOME_RANK: Record<RailOutcome["kind"], number> = { pr: 3, commit: 2, edit: 1 };
const PULL_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;
const FILE_TOOLS = new Set(["edit_file", "write_file"]);

/** Markdown collapsed to one readable run of prose. */
export function flatten(markdown: string) {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll(/`([^`]*)`/g, "$1")
    .replaceAll(/^\s{0,3}#{1,6}\s+/gm, "")
    .replaceAll(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/[*_~]{1,3}/g, "")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** Cut on a word, so the ellipsis doesn't land mid-token. */
function clamp(text: string, max: number) {
  if (text.length <= max) return text;

  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");

  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A reply sliced mid-fence would otherwise keep its backticks. */
function dropOpenFence(text: string) {
  const fences = text.match(/```/g)?.length ?? 0;

  return fences % 2 ? text.slice(0, text.lastIndexOf("```")) : text;
}

/** Quoted lines lead with what the prompt was about, not what it said; skip them unless that is all. */
function dropLeadingQuote(text: string) {
  const lines = text.split("\n");
  let at = 0;

  while (at < lines.length && (lines[at]?.startsWith(">") || !lines[at]?.trim())) at += 1;

  return lines.slice(at).join("\n").trim() || text;
}

/** Only artifacts that are unmistakable: a wrong label is worse than none on a card meant for recognition. */
function stepOutcome(step: Step): RailOutcome | undefined {
  if (step.status !== "done") return undefined;

  if (
    (step.name === "github" || step.name === "workspace") &&
    step.output.includes('"pull_request"')
  ) {
    const number = PULL_URL.exec(step.output)?.[1];

    return { kind: "pr", label: number ? `Pull request #${number}` : "Pull request" };
  }

  if (/\bgh\s+pr\s+create\b/.test(step.detail)) return { kind: "pr", label: "Pull request" };

  if (
    /\bgit\s+commit\b/.test(step.detail) ||
    (step.name === "workspace" && /^commit\b/.test(step.detail))
  )
    return { kind: "commit", label: "Commit" };

  return undefined;
}

function outcome(turn: Turn): RailOutcome | undefined {
  let best: RailOutcome | undefined;
  const edited = new Set<string>();

  for (const item of turn.items) {
    if (item.kind !== "steps") continue;

    for (const step of item.steps) {
      if (step.status === "done" && FILE_TOOLS.has(step.name) && step.file)
        edited.add(step.file.path);

      const found = stepOutcome(step);

      if (found && (!best || OUTCOME_RANK[found.kind] > OUTCOME_RANK[best.kind])) best = found;
    }
  }

  if (best || !edited.size) return best;

  return {
    kind: "edit",
    label: edited.size === 1 ? "Edited 1 file" : `Edited ${edited.size} files`,
  };
}

function reply(turn: Turn) {
  if (turn.answer) return replyPreview(turn.answer.text);

  if (turn.running) return turn.activity ?? "Working";

  if (turn.failure)
    return turn.failure.reason === "aborted" ? "Agent stopped" : "Ended without an answer";

  return "";
}

/** A prompt as the rail's one line: what it was about, or its screenshots when it has no words. */
function promptPreview(text: string, images = 0) {
  // A scheduled prompt previews as what it asks, a CI wake-up or child report as its outcome, not their labels.
  const report = parseChildReportMessage(text);

  const body =
    parseScheduledMessage(text)?.prompt ??
    parseCiWaitMessage(text)?.headline ??
    (report ? `${report.task}: ${report.headline}` : text);

  const line = clamp(flatten(dropLeadingQuote(body)), MAX_PREVIEW);

  return line || (images === 1 ? "Screenshot" : images ? `${images} screenshots` : "");
}

function replyPreview(text: string) {
  return clamp(flatten(dropOpenFence(text.slice(0, REPLY_SCAN))), MAX_REPLY);
}

/** Rail marks for the turns that start with a prompt, oldest first. */
export function railMarks(turns: readonly Turn[]): RailMark[] {
  return turns.flatMap((turn) => {
    if (!turn.prompt) return [];

    const report = turn.prompt.childReport;

    const preview = report
      ? promptPreview(`${report.task}: ${report.headline}`)
      : promptPreview(turn.prompt.text, turn.prompt.images);

    if (!preview) return [];

    const mark: RailMark = { id: turn.id, preview };
    const answer = reply(turn);
    const made = outcome(turn);

    if (answer) mark.reply = answer;

    if (made) mark.outcome = made;

    if (turn.prompt.at !== undefined) mark.at = turn.prompt.at;

    return [mark];
  });
}

/** Rail marks for prompts the server indexed, for turns the browser hasn't loaded yet. */
export function indexedMarks(prompts: (typeof PromptIndex.Type)["prompts"]): RailMark[] {
  return prompts.flatMap((prompt) => {
    const preview = promptPreview(prompt.text, prompt.images);

    if (!preview) return [];

    const mark: RailMark = { id: prompt.id, preview };

    if (prompt.reply) mark.reply = replyPreview(prompt.reply);

    if (prompt.at !== undefined) mark.at = prompt.at;

    return [mark];
  });
}

/** The transcript entry a mark's turn starts at: turn ids are `${entryId}-${messageIndex}`. */
export function markEntry(id: string) {
  const entry = Number.parseInt(id, 10);

  return Number.isNaN(entry) ? undefined : entry;
}

/**
 * The whole conversation's marks: indexed ones for the entries at or before `before` (those not loaded yet),
 * then the loaded turns'. Loaded marks win, since they know what each turn produced.
 */
export function wholeRail(
  index: readonly RailMark[],
  loaded: readonly RailMark[],
  before: number | undefined,
): RailMark[] {
  if (before === undefined || !index.length) return [...loaded];

  const earlier = index.filter((mark) => {
    const entry = markEntry(mark.id);

    return entry !== undefined && entry <= before;
  });

  return [...earlier, ...loaded];
}
