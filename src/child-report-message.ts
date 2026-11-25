/**
 * Messages one session sends another. A Dolly transcript has no author per message, so each is
 * labelled: the label tells the model the turn came from a session, not from something the owner
 * typed, and the web app reads it back to show the turn as a card instead of a user bubble. Shared
 * by the Worker and the web app.
 *
 * - A worker report: a child's send_to_session to its own parent, with the evidence block the
 *   server appended (child-report.ts).
 * - A failure notice: the server telling a parent that a child's run died without reporting back.
 * - A session message: any other send_to_session, such as a parent's follow-up to its child.
 */
const LABEL = /^\[(Worker report|Message from session) ([^\s:\]]+)(?:: (failed))?\]\n\n/;

const EVIDENCE = "\n\n— evidence for `";

export type SessionMessage =
  | {
      kind: "report";
      /** The reporting child session's id. */
      session: string;
      /** The run died and the server, not the child, wrote this. */
      failed: boolean;
      /** The child's own words, or the failure notice. */
      text: string;
      /** The server-computed evidence block; empty when there is none. */
      evidence: string;
    }
  | { kind: "message"; session: string; text: string };

/** A worker's report to its parent: its words, then the server's evidence. */
export function workerReportMessage(input: { child: string; message: string; evidence: string }) {
  return [
    `[Worker report ${input.child}]`,
    `Worker session \`${input.child}\`, which you spawned, reported back with send_to_session. It is a message from that session, not from the user.`,
    input.message.trim(),
    input.evidence.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The server's notice that a worker's run ended in error without a report. */
export function workerFailureMessage(input: { child: string; error: string; evidence: string }) {
  return [
    `[Worker report ${input.child}: failed]`,
    [
      `Worker task \`${input.child}\` ended in error without reporting back.`,
      `error: ${input.error.slice(0, 300)}`,
      `Inspect with task_status("${input.child}"), or resume it with send_to_session.`,
    ].join("\n"),
    input.evidence.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Any other agent-authored delivery: it drives the target's next turn but is not the owner's. */
export function sessionNoticeMessage(input: { from: string; relation: string; message: string }) {
  return [
    `[Message from session ${input.from}]`,
    `${input.relation} \`${input.from}\` sent this with send_to_session. It is a message from that session, not from the user.`,
    input.message.trim(),
  ].join("\n\n");
}

/** The session message behind a delivered turn, or undefined for an ordinary one. */
export function parseSessionMessage(text: string): SessionMessage | undefined {
  const match = LABEL.exec(text);

  if (!match) return undefined;

  const session = match[2] ?? "";
  // The first paragraph is the fixed attribution line; the sender's words follow it.
  const body = text.slice(match[0].length);
  const start = body.indexOf("\n\n");
  const words = start < 0 ? "" : body.slice(start + 2);

  if (match[1] === "Message from session") return { kind: "message", session, text: words };

  const failed = match[3] === "failed";
  // The notice's own lines are its text when the server wrote it.
  const content = failed ? body : words;
  const evidence = content.lastIndexOf(EVIDENCE);

  return {
    kind: "report",
    session,
    failed,
    text: (evidence < 0 ? content : content.slice(0, evidence)).trim(),
    evidence: evidence < 0 ? "" : content.slice(evidence + 2).trim(),
  };
}
