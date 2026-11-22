import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Schema from "effect/Schema";
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  Harness,
} from "@earendil-works/pi-durable";
import { ConversationWorkspace, isReadOnly } from "./workspace";
import { redact } from "./diagnostics";
import type { SavedSession } from "./session-contracts";
import { SessionIndex } from "./coordination";
import { sessionMetadataKey, type SessionMetadata } from "./model-defaults";

type PullRequestRef = { repository: string; number: number; url: string };

const PULL_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const PULL_SCAN_LIMIT = 500;

/** Find the newest pull request opened by the github or workspace tool in a transcript page. */
function findPullRequest(entries: readonly EntryRecord[]): PullRequestRef | undefined {
  for (const entry of entries) {
    for (const message of [...(entry.model ?? [])].reverse()) {
      if (message.role !== "toolResult" || message.isError) continue;

      if (message.toolName !== "github" && message.toolName !== "workspace") continue;

      for (const block of message.content) {
        if (block.type !== "text" || !block.text.includes('"pull_request"')) continue;
        const match = PULL_URL.exec(block.text);

        if (match?.[1] && match[2])
          return { repository: match[1], number: Number(match[2]), url: match[0] };
      }
    }
  }
}

/** Newest timestamp of a human-authored message in a transcript page. */
function lastPromptAt(entries: readonly EntryRecord[]): number {
  return entries.reduce(
    (time, entry) =>
      Math.max(
        time,
        ...(entry.model ?? [])
          .filter((message) => message.role === "user")
          .map((message) => message.timestamp ?? 0),
      ),
    0,
  );
}

const LIVE_STATUSES = ["running", "waiting", "sleeping"] as const;

type TranscriptSummary = {
  tip: EntryId;
  redaction: string;
  title: string;
  updatedAt: number;
  pullRequest?: PullRequestRef;
};

type Conversation = NonNullable<Awaited<ReturnType<Harness["conversation"]>>>;

/** Reuse the projection until the transcript advances or the redaction inputs change. */
async function summarizeTranscript(
  conversation: Conversation,
  storage: DurableObjectStorage,
  tip: EntryId | undefined,
  secrets: readonly string[],
  redaction: string,
): Promise<TranscriptSummary | undefined> {
  if (tip === undefined) return undefined;
  const key = `session-transcript-summary:${conversation.id}`;
  const saved = await storage.get<TranscriptSummary>(key);

  if (saved?.tip === tip && saved.redaction === redaction) return saved;

  // First prompts are immutable, including inherited history. Don't persist unredacted titles.
  let title = saved?.redaction === redaction ? saved.title : "";
  let history: Cursor | undefined;

  while (!title) {
    const entries = await conversation.entries(
      { order: "ascending", maxEntryId: tip },
      50,
      history,
      BACKGROUND_CONTEXT,
    );

    for (const entry of entries.items) {
      const prompt = entry.model?.find((message) => message.role === "user");

      if (!prompt) continue;

      const text = Schema.is(Schema.String)(prompt.content)
        ? prompt.content
        : prompt.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

      // Redact before truncating: a secret cut at the limit would no longer match.
      title = redact(text.trim().split("\n")[0] ?? "", secrets).slice(0, 80);

      if (title) break;
    }

    history = entries.next;

    if (!history) break;
  }

  // Keep PR links found by the old listing, including those now beyond the scan window.
  const legacy = saved
    ? undefined
    : await storage.get<PullRequestRef & { seen: string }>(`session-pr:${conversation.id}`);

  const previousTip = saved ? String(saved.tip) : legacy?.seen;

  const fallbackPull =
    saved?.pullRequest ??
    (legacy?.url
      ? { repository: legacy.repository, number: legacy.number, url: legacy.url }
      : undefined);

  let pullRequest: PullRequestRef | undefined;
  let checkingPull = previousTip !== String(tip);
  let updatedAt = 0;
  let cursor: Cursor | undefined;
  let scanned = 0;

  do {
    const page = await conversation.entries(
      { order: "descending", maxEntryId: tip },
      50,
      cursor,
      BACKGROUND_CONTEXT,
    );

    if (!updatedAt) updatedAt = lastPromptAt(page.items);

    if (checkingPull) {
      const boundary = previousTip
        ? page.items.findIndex((entry) => String(entry.id) === previousTip)
        : -1;

      pullRequest = findPullRequest(boundary < 0 ? page.items : page.items.slice(0, boundary));
      checkingPull = !pullRequest && boundary < 0;
    }

    scanned += page.items.length;
    cursor = page.next;
  } while ((!updatedAt || checkingPull) && cursor && scanned < PULL_SCAN_LIMIT);

  const summary = { tip, redaction, title, updatedAt, pullRequest: pullRequest ?? fallbackPull };
  await storage.put(key, summary);

  return summary;
}

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

  const redaction = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(secrets))),
    ),
  ).join(",");

  const running = await harness.commit(async (tx) => {
    const live = new Set<ConversationId>();

    for (const status of LIVE_STATUSES) {
      let cursor: Cursor | undefined;

      do {
        const page = await tx.scanTasks({ status, background: false }, 100, cursor);

        for (const task of page.items) live.add(task.conversationId);
        cursor = page.next;
      } while (cursor);
    }

    return live;
  }, BACKGROUND_CONTEXT);

  const sessions: SavedSession[] = [];
  let cursor: Cursor | undefined;

  do {
    const page = await harness.commit(async (tx) => {
      const page = await tx.scanConversations({}, 100, cursor);
      const index = await tx.doc(SessionIndex);
      const records = [];

      for (const record of page.items) {
        // Make discovered pre-index conversations openable by their canonical ID too.
        if (!Object.hasOwn(index.ids, record.id)) index.ids[record.id] = record.id;
        records.push({ record, tip: await tx.latestEntryId(record.id) });
      }

      return { records, next: page.next };
    }, BACKGROUND_CONTEXT);

    // Keep cold backfill bounded without serializing every storage read across all sessions.
    for (let offset = 0; offset < page.records.length; offset += 8) {
      const batch = await Promise.all(
        page.records.slice(offset, offset + 8).map(async ({ record, tip }) => {
          const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);

          if (!conversation) return;

          const [agent, workspace, metadata, transcript, createdPull] = await Promise.all([
            conversation.agent(BACKGROUND_CONTEXT),
            harness.snapshot(ConversationWorkspace, record.id, BACKGROUND_CONTEXT),
            storage.get<SessionMetadata>(sessionMetadataKey(record.id)),
            summarizeTranscript(conversation, storage, tip, secrets, redaction),
            storage.get<PullRequestRef>(`session-created-pr:${record.id}`),
          ]);

          const parent = record.owner?.conversationId;

          return {
            id: aliases.get(record.id) ?? String(record.id),
            ...(metadata?.workspaceId && { workspaceId: metadata.workspaceId }),
            ...(metadata?.createdAt && { createdAt: metadata.createdAt }),
            model: agent.model?.modelId ?? "Existing session",
            thinkingLevel: agent.thinkingLevel,
            ...(metadata?.speed && { speed: metadata.speed }),
            ...(metadata?.autoFallback !== undefined && { autoFallback: metadata.autoFallback }),
            title:
              (metadata?.title && redact(metadata.title, secrets)) ||
              transcript?.title ||
              "Untitled session",
            repository: workspace?.config?.repository ?? "",
            ref: workspace?.config?.ref,
            updatedAt: Math.max(transcript?.updatedAt ?? 0, metadata?.createdAt ?? 0),
            archived: metadata?.archived ?? false,
            ...(parent && { parentId: aliases.get(parent) ?? String(parent) }),
            ...(parent && metadata?.kept && { kept: true }),
            // Only automatic reviews are read-only (github-inbox.ts admitGitHub).
            ...(isReadOnly(workspace) && { automation: "review" as const }),
            running: running.has(record.id),
            pullRequest: createdPull ?? transcript?.pullRequest,
          } satisfies SavedSession;
        }),
      );

      for (const session of batch) if (session) sessions.push(session);
    }

    cursor = page.next;
  } while (cursor);

  return withWorkspaces(sessions).sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
}

/**
 * Every session's workspace: spawned sessions join their root's, and a root recorded before
 * workspaces existed is a workspace of its own, keyed by its session ID.
 */
export function withWorkspaces(sessions: readonly SavedSession[]): SavedSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));

  return sessions.map((session) => {
    let root = session;
    const seen = new Set([session.id]);

    while (root.parentId && !seen.has(root.parentId)) {
      const parent = byId.get(root.parentId);

      if (!parent) break;
      seen.add(parent.id);
      root = parent;
    }

    return { ...session, workspaceId: root.workspaceId ?? root.id };
  });
}
