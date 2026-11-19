/**
 * The message a finished CI wait arrives as. The label tells the model the turn is a background
 * wake-up, not something the owner typed; the web app reads it back to show the turn as a CI
 * notice instead of a user bubble. Shared by the Worker and the web app.
 */
const LABEL = /^\[CI wait ([^\s:\]]+): ([^\n\]]+)\]\n\n/;

export const CI_WAIT_OUTCOMES = ["passed", "failed", "closed", "timed_out", "finished"] as const;

export type CiWaitOutcome = (typeof CI_WAIT_OUTCOMES)[number];

export function ciWaitMessage(
  id: string,
  wake: { outcome: CiWaitOutcome; headline: string; detail: string; prompt: string },
) {
  return [
    `[CI wait ${id}: ${wake.outcome} · ${wake.headline.replaceAll(/[\n\]]/g, " ")}]`,
    "A background wait you registered with wait_for has finished. This is system context, not a message from the user.",
    `Trigger: ${wake.detail}`,
    `Continue with: ${wake.prompt}`,
    "If this leaves nothing you can act on (checks still running, or waiting on a person), don't restate earlier status: reply in one short line, call wait_for again only if you still need to, and end your turn.",
  ].join("\n\n");
}

/** The wait behind a delivered message, or undefined for an ordinary one. */
export function parseCiWaitMessage(text: string) {
  const match = LABEL.exec(text);

  if (!match) return undefined;

  const label = match[2] ?? "";
  const split = label.indexOf(" · ");
  const outcome = CI_WAIT_OUTCOMES.find((value) => value === label.slice(0, split));

  if (split < 0 || !outcome) return undefined;

  const sections = text.slice(match[0].length).split("\n\n");

  const field = (prefix: string) =>
    sections.find((section) => section.startsWith(prefix))?.slice(prefix.length) ?? "";

  return {
    id: match[1] ?? "",
    outcome,
    headline: label.slice(split + 3),
    trigger: field("Trigger: "),
    prompt: field("Continue with: "),
  };
}
