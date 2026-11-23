import { expect, it } from "vite-plus/test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { unanswered } from "../src/automation-tool";

/** A transcript, oldest first, as `unanswered` pages it (newest first, one page). */
function transcript(...entries: [kind: string, message: Message][]) {
  const records: EntryRecord[] = entries.map(([kind, message], index) => ({
    // SAFETY: entry IDs are opaque to unanswered(), which only collects them; the fixture's
    // IDs are positions in this transcript.
    id: (index + 1) as EntryId,
    // SAFETY: the conversation is never read; one transcript is one conversation.
    conversationId: 1 as EntryRecord["conversationId"],
    kind,
    model: [message],
  }));

  return unanswered(async () => ({ items: records.toReversed(), next: undefined }));
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

function assistant(text: string, stopReason: AssistantMessage["stopReason"]): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-sol",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

it("keeps a handoff unanswered when its reply was stopped mid-stream", async () => {
  // The handoff (1) started a reply the owner stopped after text streamed (2); the owner then
  // asks for something else (3). The handoff is still what the model may act on.
  expect(
    await transcript(
      ["pi.user", user("[Review handoff] Add a nightly automation.")],
      ["pi.assistant", assistant("I'll add the nightly", "aborted")],
      ["pi.user", user("Check CI again")],
    ),
  ).toEqual([3, 1]);

  // A finished answer closes it: only the owner's later message is unanswered.
  expect(
    await transcript(
      ["pi.user", user("[Review handoff] Add a nightly automation.")],
      ["pi.assistant", assistant("Done, the handoff is answered", "stop")],
      ["pi.user", user("Pause my weekly changelog")],
    ),
  ).toEqual([3]);
});

it("doesn't count a compaction summary as an input", async () => {
  // Compaction ran after the owner's message, before the reply: its user-role summary was
  // submitted by no one, and the owner's message is still the only input.
  expect(
    await transcript(
      ["pi.user", user("Earlier request")],
      ["pi.assistant", assistant("Earlier answer", "stop")],
      ["pi.user", user("Pause my weekly changelog")],
      ["pi.compaction", user("Summary of the session so far")],
    ),
  ).toEqual([3]);

  // An application's own input kinds still count, so an unknown input fails closed.
  expect(
    await transcript(
      ["pi.assistant", assistant("Earlier answer", "stop")],
      ["app.notice", user("Text from somewhere else")],
    ),
  ).toEqual([2]);
});
