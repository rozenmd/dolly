/**
 * The message a child session's report arrives as in its parent. The label tells the model the
 * turn is a report from a session it delegated to, not something the owner typed; the web app
 * reads it back to show the turn as a report card instead of a user bubble. Shared by the Worker
 * and the web app.
 */
const LABEL = /^\[Child report ([^\s:\]]+): ([^\n\]]+)\]\n\n/;

export const CHILD_REPORT_OUTCOMES = ["answered", "stopped"] as const;

export type ChildReportOutcome = (typeof CHILD_REPORT_OUTCOMES)[number];

const REPLY = "\n\nReply:\n";

const EVIDENCE =
  "\n\nEvidence (computed by Dolly from the child's transcript, not written by it):\n";

const WORKING = "\n\nStill working: ";
const NEXT = "\n\nNext: ";

export type ChildReport = {
  /** The child session's id. */
  child: string;
  outcome: ChildReportOutcome;
  headline: string;
  /** What the child was asked to do, in one line. */
  task: string;
  /** The child's own words: its final reply, or why it stopped. */
  reply: string;
  /** Facts computed from the child's transcript, one per line. */
  evidence: string;
  /** Other children of the parent still working, in one line; empty when none. */
  working: string;
  next: string;
};

const oneLine = (text: string) => text.replaceAll(/[\n\]]/g, " ").trim();

export function childReportMessage(report: Omit<ChildReport, "next">) {
  const next =
    report.outcome === "answered"
      ? `Decide the next step: follow up with send_to_session (id ${report.child}), start other work, or tell the owner what changed, in a sentence or two, linking the child session rather than pasting its transcript. If other children are still working and nothing here needs action yet, reply in one short line and end your turn; their reports arrive the same way.`
      : `The child stopped without finishing its turn. Look with task_status (id ${report.child}), then follow up with send_to_session, or do the work here.`;

  return [
    `[Child report ${report.child}: ${report.outcome} · ${oneLine(report.headline)}]\n\n`,
    `A child session you started with spawn_task finished its turn. This is system context, not a message from the user.\n\nTask: ${oneLine(report.task)}`,
    `${REPLY}${report.reply.trim() || "(no reply)"}`,
    report.evidence.trim() ? `${EVIDENCE}${report.evidence.trim()}` : "",
    report.working.trim() ? `${WORKING}${oneLine(report.working)}` : "",
    `${NEXT}${next}`,
  ].join("");
}

/** The report behind a delivered message, or undefined for an ordinary one. */
export function parseChildReportMessage(text: string): ChildReport | undefined {
  const match = LABEL.exec(text);

  if (!match) return undefined;

  const label = match[2] ?? "";
  const split = label.indexOf(" · ");
  const outcome = CHILD_REPORT_OUTCOMES.find((value) => value === label.slice(0, split));

  if (split < 0 || !outcome) return undefined;

  const body = text.slice(match[0].length);
  const reply = body.indexOf(REPLY);
  const next = body.lastIndexOf(NEXT);

  if (reply < 0 || next < reply) return undefined;

  // The reply is the child's own text, so the sections after it are found from the end.
  const working = body.lastIndexOf(WORKING, next);
  const evidence = body.lastIndexOf(EVIDENCE, working > reply ? working : next);
  const replyEnd = [evidence, working, next].find((at) => at > reply) ?? next;
  const task = body.slice(0, reply).split("\n\nTask: ")[1] ?? "";

  return {
    child: match[1] ?? "",
    outcome,
    headline: label.slice(split + 3),
    task,
    reply: body.slice(reply + REPLY.length, replyEnd),
    evidence:
      evidence > reply
        ? body.slice(evidence + EVIDENCE.length, working > evidence ? working : next)
        : "",
    working: working > reply ? body.slice(working + WORKING.length, next) : "",
    next: body.slice(next + NEXT.length),
  };
}
