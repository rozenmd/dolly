/**
 * The note an interrupting message carries. "Interrupt and send now" stops the running turn and
 * delivers the message as the next one; a turn cut off mid-task otherwise primes a short
 * acknowledge-then-stop reply, so the note reframes the delivery as a mid-task steer. The web app
 * strips it, so the conversation shows only the owner's words. Shared by the Worker and the web app.
 */
export const INTERRUPT_NOTE =
  "Delivery note: the user sent this while your previous turn was still " +
  "executing; that turn was interrupted to deliver it. Treat it as a mid-task " +
  "steer — fold it into the work in progress and continue executing in THIS " +
  "turn: pick up any interrupted step that is still needed, act on the new " +
  "message, and keep working until done or genuinely blocked. Do not end the " +
  "turn on a bare acknowledgment or an announcement of what you will do.";

const OPEN = "<interrupt-note>";
const CLOSE = "</interrupt-note>";

/** The note as the text block appended to an interrupting message. */
export const INTERRUPT_NOTE_BLOCK = `${OPEN}\n${INTERRUPT_NOTE}\n${CLOSE}`;

const TRAILING_NOTE = /\s*<interrupt-note>\n[\s\S]*?\n<\/interrupt-note>\s*$/;

/** Whether a message interrupted the turn before it ("Interrupt and send now"). */
export function interrupts(text: string) {
  return TRAILING_NOTE.test(text);
}

/** A message's text without the interrupt note it ends with, if any. */
export function stripInterruptNote(text: string) {
  return text.replace(TRAILING_NOTE, "");
}
