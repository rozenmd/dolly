import {
  defineDoc,
  type ConversationView,
  type InboxItem,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The kind of `OwnerInputDoc`, sent with a non-empty queue so the browser knows which messages it may edit. */
export const OWNER_INPUTS_DOC = "app.owner-inputs";

const EditableContent = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
]);

const QueuedItems = Schema.Struct({ items: Schema.Array(Schema.Unknown) });

/**
 * The text of a queued input that can go back into the composer: plain text, or text blocks only.
 * A screenshot can't be restored into a draft, so a message carrying one has none.
 */
export function editableText(item: Extract<InboxItem, { mode: "followUp" | "steer" }>) {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(EditableContent)(item.content).pipe(
      Option.map((content) =>
        Schema.is(Schema.String)(content)
          ? content
          : content.map((block) => block.text).join("\n\n"),
      ),
    ),
  );
}

/** Whether a view's `pi.inbox` document holds anything. */
export function hasQueued(docs: ConversationView["docs"]) {
  return Option.match(Schema.decodeUnknownOption(QueuedItems)(docs["pi.inbox"]), {
    onNone: () => false,
    onSome: (value) => value.items.length > 0,
  });
}

/** A queued item as plain JSON, so it can move to another slot of the inbox document's draft. */
export function copyInboxItem(item: InboxItem): InboxItem {
  // SAFETY: JSON round-trips keep the shape of the JSON-only values Pi documents hold.
  return JSON.parse(JSON.stringify(item)) as InboxItem;
}

/** A submission ID from the HTTP API, for the harness, which checks it belongs to the conversation. */
export function submissionId(id: number): SubmissionId {
  // SAFETY: submission IDs are plain positive integers on the wire; routes validate them first.
  return id as SubmissionId;
}

/**
 * An interrupt in progress ("Interrupt and send now"): the queued inputs taken out of the inbox
 * while the running turn is aborted, so the abort can't withdraw them, and the one that interrupts.
 * The commit that sends `target` puts the others back. Empty when no interrupt is in progress.
 */
export const InterruptDoc = defineDoc<{ target?: SubmissionId; items: InboxItem[] }>({
  kind: "app.interrupt",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
  checkpointWhen: (value) => value.target === undefined,
});
