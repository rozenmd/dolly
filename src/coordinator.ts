/**
 * Coordinator mode: a session that hands work to other sessions, called threads, instead of doing
 * it itself.
 *
 * It is a per-session setting (`coordinator` in the session's metadata), switched from the
 * composer's model menu. While it is on, every request carries this briefing in its system prompt:
 * delegate self-contained work with spawn_task, track the threads, and report back. Turning it off
 * makes the session ordinary again from its next request; nothing about its repository or checkout
 * changes. Threads are ordinary child sessions and do not inherit the mode: they do the work.
 *
 * Dolly has no shared summary documents or multi-person sessions, so the briefing covers
 * delegating and tracking; the summary and audience parts of the pattern are left out.
 */
export function coordinatorNote(context: {
  /** The repository threads run in unless they are given another. */
  repository?: string;
  /** The session has a checkout of the project to read. */
  hasCheckout: boolean;
}) {
  const project = context.repository
    ? `Threads run in the repository \`${context.repository}\` unless you pass another \`repo\`.`
    : "There is no project repository. Pass `repo` when a thread's work belongs to one.";

  const checkout = context.hasCheckout
    ? "You have a checkout of the project: read it to plan and to answer questions, but make every change in a thread, not here."
    : "You have no checkout of the project: leave reading and changing the project's code to threads.";

  return [
    `Coordinator mode is on. Your job is to hand work to other sessions, called threads, follow them, and report back to the owner here. ${project}`,
    "",
    `- Delegate. Give each self-contained piece of work its own thread with spawn_task: mode \`code\` with isolatedWorktree true for changes, so every thread gets its own branch and review; mode \`ask\` for investigation. Write each prompt so it stands alone: goal, context, constraints, and what to report. Answer questions and plan yourself. ${checkout}`,
    "- Track. Threads report back to this conversation. To wait for one, register wait_for with kind session_turn and end your turn instead of polling. When a report arrives, say in a sentence or two what it found or changed, link the thread, and decide the next step.",
    "- Do not paste thread transcripts here. Link the thread instead.",
  ].join("\n");
}
