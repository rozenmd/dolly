import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Schema from "effect/Schema";
import type { ConversationId, Cursor, Harness } from "@earendil-works/pi-durable";
import { ConversationWorkspace } from "./workspace";
import { redact } from "./diagnostics";
import type { SavedSession } from "./session-contracts";
import { indexSession } from "./coordination";

type Metadata = { archived: boolean; createdAt?: number };

/** Discover history, not just sessions created after this feature was deployed. */
export async function listSessions(
  harness: Harness,
  storage: DurableObjectStorage,
  secrets: readonly string[],
): Promise<SavedSession[]> {
  const aliases = new Map<ConversationId, string>();
  let start: string | undefined;

  do {
    const page = await storage.list<ConversationId>({
      prefix: "session:",
      startAfter: start,
      limit: 1000,
    });

    for (const [key, id] of page) aliases.set(id, key.slice("session:".length));
    start = page.size === 1000 ? [...page.keys()].at(-1) : undefined;
  } while (start);

  const sessions: SavedSession[] = [];
  let cursor: Cursor | undefined;

  do {
    const page = await harness.commit(async (tx) => {
      const page = await tx.scanConversations({}, 100, cursor);

      // Make discovered pre-index conversations openable by their canonical ID too.
      for (const record of page.items) await indexSession(tx, record.id);

      return page;
    }, BACKGROUND_CONTEXT);

    for (const record of page.items) {
      const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);

      if (!conversation) continue;

      const [agent, workspace, metadata, latest] = await Promise.all([
        conversation.agent(BACKGROUND_CONTEXT),
        harness.snapshot(ConversationWorkspace, record.id, BACKGROUND_CONTEXT),
        storage.get<Metadata>(`session-meta:${record.id}`),
        conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT),
      ]);

      let title = "";
      let history: Cursor | undefined;

      // The first prompt may be outside the recent transcript window.
      do {
        const entries = await conversation.entries(
          { order: "ascending" },
          50,
          history,
          BACKGROUND_CONTEXT,
        );

        for (const entry of entries.items) {
          const prompt = entry.model?.find((message) => message.role === "user");

          if (!prompt) continue;

          const text = Schema.is(Schema.String)(prompt.content)
            ? prompt.content
            : prompt.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n");

          title = text.trim().split("\n")[0]?.slice(0, 80) ?? "";

          if (title) break;
        }

        history = entries.next;
      } while (!title && history);

      const updatedAt = latest.items.reduce(
        (time, entry) =>
          Math.max(time, ...(entry.model ?? []).map((message) => message.timestamp ?? 0)),
        metadata?.createdAt ?? 0,
      );

      sessions.push({
        id: aliases.get(record.id) ?? String(record.id),
        model: agent.model?.modelId ?? "Existing session",
        title: redact(title || "Untitled session", secrets),
        repository: workspace?.config?.repository ?? "",
        ref: workspace?.config?.ref,
        updatedAt,
        archived: metadata?.archived ?? false,
      });
    }

    cursor = page.next;
  } while (cursor);

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
