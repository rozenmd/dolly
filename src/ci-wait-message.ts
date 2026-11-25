/**
 * The message a finished wait arrives as: a CI wait, or a session_turn wait on another session. The label tells the model the turn is a background
 * wake-up, not something the owner typed; the web app reads it back to show the turn as a CI
 * notice instead of a user bubble. Shared by the Worker and the web app.
 */
const LABEL = /^\[(CI|Session) wait ([^\s:\]]+): ([^\n\]]+)\]\n\n/;

const PREAMBLE =
  "A background wait you registered with wait_for has finished. This is system context, not a message from the user.";

const CLOSING =
  "If this leaves nothing you can act on (checks still running, or waiting on a person), don't restate earlier status: reply in one short line, call wait_for again only if you still need to, and end your turn.";

export const CI_WAIT_OUTCOMES = ["passed", "failed", "closed", "timed_out", "finished"] as const;

export type CiWaitOutcome = (typeof CI_WAIT_OUTCOMES)[number];

export function ciWaitMessage(
  id: string,
  wake: { outcome: CiWaitOutcome; headline: string; detail: string; prompt: string },
) {
  return [
    `[CI wait ${id}: ${wake.outcome} · ${wake.headline.replaceAll(/[\n\]]/g, " ")}]`,
    PREAMBLE,
    `Trigger: ${wake.detail}`,
    `Continue with: ${wake.prompt}`,
    CLOSING,
  ].join("\n\n");
}

/**
 * A session_turn wait's wake-up: the watched session's state and the tail of its last message,
 * which may run to several paragraphs, so it follows the trigger line rather than sitting in it.
 */
export function sessionWaitMessage(
  id: string,
  wake: { outcome: CiWaitOutcome; headline: string; detail: string; prompt: string },
) {
  return [
    `[Session wait ${id}: ${wake.outcome} · ${wake.headline.replaceAll(/[\n\]]/g, " ")}]`,
    PREAMBLE,
    `Trigger: ${wake.headline.replaceAll("\n", " ")}`,
    wake.detail,
    `Continue with: ${wake.prompt}`,
    CLOSING,
  ].join("\n\n");
}

/** The wait behind a delivered message, or undefined for an ordinary one. */
export function parseCiWaitMessage(text: string) {
  const match = LABEL.exec(text);

  if (!match) return undefined;

  const label = match[3] ?? "";
  const split = label.indexOf(" · ");
  const outcome = CI_WAIT_OUTCOMES.find((value) => value === label.slice(0, split));

  if (split < 0 || !outcome) return undefined;

  const sections = text.slice(match[0].length).split("\n\n");

  const field = (prefix: string) =>
    sections.find((section) => section.startsWith(prefix))?.slice(prefix.length) ?? "";

  const session = match[1] === "Session";

  // A session wake's detail is the watched session's own text, so it is cut out by position.
  const start = sections.findIndex((section) => section.startsWith("Trigger: "));
  const end = sections.findLastIndex((section) => section.startsWith("Continue with: "));

  return {
    kind: session ? ("session_turn" as const) : ("ci" as const),
    id: match[2] ?? "",
    outcome,
    headline: label.slice(split + 3),
    trigger:
      session && start >= 0 && end > start
        ? sections.slice(start + 1, end).join("\n\n")
        : field("Trigger: "),
    prompt: end >= 0 ? (sections[end]?.slice("Continue with: ".length) ?? "") : "",
  };
}
