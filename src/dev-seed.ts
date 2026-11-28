import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  type EntryDraft,
} from "@earendil-works/pi-durable";
import type { Env } from "./env";

/**
 * Local development only (`DOLLY_DEV_SIGNED_IN=1 pnpm dev:sandbox`): every request is signed in
 * as a seeded owner, without a cookie, and one session with a short transcript is seeded, so a
 * preview browser (which sends no cookies) can render signed-in pages. Needs both bindings, and
 * only test/worker/vite.config.ts can set DEV_SIGNED_IN; the production config sets
 * ACCESS_LOCAL_DEV to "false" and declares no DEV_SIGNED_IN (scripts/config.test.mjs).
 */
export const devSignedIn = (env: Env) =>
  env.ACCESS_LOCAL_DEV === "true" && env.DEV_SIGNED_IN === "true";

export const DEV_OWNER = { id: 1, login: "octocat" } as const;

export const DEV_SESSION_TITLE = "Seeded dev session";

const usage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-codex-responses",
  provider: "openai",
  model: "gpt-6-luna",
  usage,
  stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  timestamp,
});

/** The seeded transcript: a prompt, a shell call and its output, and an answer. */
export function devTranscript(now: number): EntryDraft[] {
  return [
    {
      kind: UserEntry.kind,
      model: [{ role: "user", content: "List the files in the repository root.", timestamp: now }],
    },
    {
      kind: AssistantEntry.kind,
      model: [
        assistant(
          [
            { type: "text", text: "I'll list them." },
            { type: "toolCall", id: "call_dev_1", name: "shell", arguments: { command: "ls" } },
          ],
          now + 1_000,
        ),
      ],
    },
    {
      kind: ToolResultEntry.kind,
      data: { diagnostics: [] },
      model: [
        {
          role: "toolResult",
          toolCallId: "call_dev_1",
          toolName: "shell",
          content: [{ type: "text", text: "README.md\npackage.json\nsrc\nweb" }],
          isError: false,
          timestamp: now + 2_000,
        },
      ],
    },
    {
      kind: AssistantEntry.kind,
      model: [
        assistant(
          [
            {
              type: "text",
              text: "The root holds `README.md`, `package.json`, `src/` (the Worker) and `web/` (the web app).",
            },
          ],
          now + 3_000,
        ),
      ],
    },
  ];
}
