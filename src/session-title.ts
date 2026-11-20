import * as Schema from "effect/Schema";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Cursor, Harness } from "@earendil-works/pi-durable";

/**
 * Generated session titles, ported from opensession's `generated-titles.ts`: a short 3–6 word
 * imperative name ("Add onboarding flow") from a one-shot call on the cheapest model of the
 * default model's provider, instead of the raw first line of the first prompt. Dolly exposes it
 * as the agent tool `retitle_session`, so the agent can rename its session when the work moves on.
 */

/** Longest prompt excerpt sent for titling, as in opensession. */
const SOURCE_CHARS = 2_000;

/** Stored titles are capped like opensession's; the sidebar truncates further. */
const TITLE_CHARS = 60;

export const RETITLE_TOOL_NAME = "retitle_session";

export const retitleDescription =
  "Regenerate this session's title: a cheap one-shot call on the cheapest model of the owner's default model provider (Claude Haiku or GPT-6 Luna) names the work from the first and latest prompts as a 3–6 word imperative, like a PR title. Use it when the conversation has moved on to different work than its title says. It replaces the title shown in the sidebar and returns it; an unusable answer keeps the current title.";

export const RetitleToolInput = Schema.Struct({});

/** Text of a user message's text blocks. */
export function messageText(message: Message) {
  if (message.role !== "user") return "";

  return Schema.is(Schema.String)(message.content)
    ? message.content
    : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The one-shot prompt: opensession's naming instructions, judged against the latest request. */
export function titlePrompt(input: { first: string; latest?: string; current?: string }) {
  const first = input.first.trim().slice(0, SOURCE_CHARS);
  const latest = input.latest?.trim().slice(0, SOURCE_CHARS);
  const followUp = latest && latest !== first;

  return [
    `Summarize ${followUp ? "the work in this conversation with a coding agent" : "this task"} as a short title of 3 to 6 words, phrased as an imperative like a git branch or PR title (e.g. "Add onboarding flow", "Fix layout thumbnails", "Raise timeline playhead"). Sentence case, no trailing punctuation, no quotes, no code. Always name the task, even when it is a question, an investigation or a discussion rather than a code change — never comment on the task itself.`,
    ...(followUp
      ? [
          "Name what the conversation is doing now: if the latest message starts unrelated work, name that work; otherwise name the original task.",
        ]
      : []),
    ...(input.current ? [`The current title is "${input.current}".`] : []),
    "Output ONLY the title, nothing else.",
    "",
    followUp ? "First message:" : "Task:",
    `"""\n${first}\n"""`,
    ...(followUp ? ["", "Latest message:", `"""\n${latest}\n"""`] : []),
  ].join("\n");
}

/** Trim a raw model output into a clean short title, or "" if unusable (opensession's rules). */
export function sanitizeTitle(raw: string) {
  const line = (raw.trim().split("\n")[0] ?? "")
    .replace(/^["'`*]+|["'`*]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // The model occasionally answers instead of naming; keep the current title rather than prose.
  if (
    line.split(" ").length > 9 ||
    /\.\s/.test(line) ||
    /^(i|i'm|this|that|there|sorry|it)\b/i.test(line)
  )
    return "";

  return line
    .replace(/[.\s]+$/g, "")
    .slice(0, TITLE_CHARS)
    .trim();
}

/** The assistant text of a completed one-shot, or the reason there is none. */
export function completionText(message: AssistantMessage) {
  if (message.stopReason === "error" || message.stopReason === "aborted")
    return { error: message.errorMessage ?? "Title model request failed" };

  return {
    text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
  };
}

type Conversation = NonNullable<Awaited<ReturnType<Harness["conversation"]>>>;

/** Scan pages for prompts; a title needs only the first and newest, so stop early. */
const PROMPT_SCAN_LIMIT = 500;

/** The first and newest non-empty user prompts in a conversation, inherited history included. */
export async function promptBounds(conversation: Conversation) {
  const find = async (order: "ascending" | "descending") => {
    let cursor: Cursor | undefined;
    let scanned = 0;

    do {
      const page = await conversation.entries({ order }, 50, cursor, BACKGROUND_CONTEXT);

      for (const entry of page.items) {
        const messages = order === "ascending" ? entry.model : [...(entry.model ?? [])].reverse();

        for (const message of messages ?? []) {
          const text = messageText(message).trim();

          if (text) return text;
        }
      }

      scanned += page.items.length;
      cursor = page.next;
    } while (cursor && scanned < PROMPT_SCAN_LIMIT);
  };

  const first = await find("ascending");

  return first ? { first, latest: await find("descending") } : undefined;
}
