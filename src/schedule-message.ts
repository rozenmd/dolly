/**
 * The message a scheduled prompt arrives as. The label tells the model the turn was scheduled
 * rather than typed now; the web app reads it back to show the turn as a scheduled notice
 * instead of words the owner just sent. Shared by the Worker and the web app.
 */
const LABEL = /^\[Scheduled prompt ([^\s,\]]+), set at ([^\s\]]+) for ([^\s\]]+)\]\n\n/;

export function scheduledMessage(
  id: string,
  input: { prompt: string; createdAt: number; at: number },
) {
  return `[Scheduled prompt ${id}, set at ${new Date(input.createdAt).toISOString()} for ${new Date(input.at).toISOString()}]\n\n${input.prompt}`;
}

/** The schedule behind a delivered message, or undefined for an ordinary one. */
export function parseScheduledMessage(text: string) {
  const match = LABEL.exec(text);

  if (!match) return undefined;

  const createdAt = Date.parse(match[2] ?? "");
  const at = Date.parse(match[3] ?? "");

  if (Number.isNaN(createdAt) || Number.isNaN(at)) return undefined;

  return { id: match[1] ?? "", createdAt, at, prompt: text.slice(match[0].length) };
}
