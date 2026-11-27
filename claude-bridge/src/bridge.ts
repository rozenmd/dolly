/**
 * Anthropic bridge: an endpoint that speaks the Anthropic Messages API (`POST /v1/messages`,
 * streaming included) but is served by the official Claude Agent SDK, so Dolly's Claude requests
 * are real Claude Code traffic on the owner's subscription.
 *
 * A port of Open Session's anthropic-bridge.ts (MIT, see third_party/opensession/LICENSE), which
 * reimplements the mapping pioneered by Pi-with-claude and @rynfar/meridian:
 *
 *  - The client's tools are registered as an in-process SDK MCP server, so the model emits real
 *    tool_use blocks for them. Their handlers don't run anything: each waits for the client's
 *    result. Once a model call's tool calls are all waiting, they return to the client as Anthropic
 *    `tool_use` blocks with stop_reason "tool_use", and the client (Dolly) runs the tools itself.
 *  - The client's next request carries the results. They go to the waiting handlers, so Claude Code
 *    hands them to the model as the tool_result of each call and its turn carries on: the model
 *    works through many tool rounds in one turn, with nothing telling it to stop, as it would with
 *    the API directly. Only the model's final answer (no tool calls) ends the Claude Code turn.
 *  - Each client session maps to one SDK session, keyed by the `x-dolly-session` header (else a
 *    fingerprint of the first message). A follow-up request resumes that session with only the new
 *    tail; a diverged or compacted history starts a fresh session with a full flat-text replay. A
 *    process lost mid-turn (or a turn the client abandoned) resumes at the last finished turn and
 *    replays the rounds since as text.
 *  - Only the current user turn's images reach the SDK, as structured content.
 *  - A session's Claude Code process stays running between its requests (streaming input), so a
 *    follow-up skips the CLI's start-up, which takes seconds on a container's CPU. A request that
 *    needs other options, or finds the process gone, starts a new one that resumes the session.
 *
 * Known approximations, as in Open Session: no token-level streaming (a streamed response opens at
 * once, pings while the SDK works, then replays the finished message as Anthropic SSE events),
 * `temperature` is ignored, and thinking blocks are not returned. The SDK's own built-in tools are
 * removed; only the client's tools exist.
 */
import { createHash } from "node:crypto";
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MessagesRequest,
  flattenMessageText,
  sdkTurn,
  sdkTurnContent,
  sdkTurnText,
  systemText,
  ToolArguments,
  type JsonObject,
  type Message,
  type ToolResultBlock,
} from "./messages.ts";
import { toolInputSchema } from "./tool-schema.ts";
import { isAccountNotice, isLimitErrorKind, limitErrorMessage } from "./limits.ts";

/** The SDK MCP server the client's tools are registered under: the model sees `mcp__dolly__<name>`. */
export const PASSTHROUGH_MCP = "dolly";
export const PASSTHROUGH_PREFIX = `mcp__${PASSTHROUGH_MCP}__`;

/**
 * Built-in SDK tools the bridge must never let run: the client owns all execution. An empty `tools`
 * list is the primary switch (it also removes built-ins added by later SDK releases); this list and
 * the blocking PreToolUse hook are backstops.
 */
export const DISALLOWED_BUILTINS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Agent",
  "Skill",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ToolSearch",
  "Workflow",
];

/** Anthropic's own Messages API request limit: Dolly's four 5 MiB images fit, base64 and all. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_SESSIONS = 500;
const HEARTBEAT_MS = 15_000;

/** Claude Code processes kept waiting for their session's next request, and for how long. */
const MAX_LIVE = 6;
const LIVE_IDLE_MS = 10 * 60_000;

/** Far above any real window: the CLI never refuses a request on its own token estimate. */
const CLI_BLOCKING_LIMIT_OFF = 1_000_000_000;

/**
 * How long a process waits for the client's tool results before it is closed: past Dolly's longest
 * tool call (an hour-long shell command). A later request then resumes on a new process.
 */
const TOOL_WAIT_MS = 70 * 60_000;

/**
 * Backstop for a round Claude Code holds part of back (a concurrency cap): once the model call is
 * done and nothing more starts for this long, the calls that did start go to the client, and the
 * rest follow as their own round.
 */
const ROUND_SETTLE_MS = 2_000;

/** How long closing a process mid-tool-loop waits for its turn to be interrupted. */
const INTERRUPT_WAIT_MS = 2_000;

/** Model calls in one Claude Code turn: a whole tool loop is one turn, so far above any real one. */
const MAX_TURNS = 10_000;

/** Concurrent tool calls Claude Code starts at once: every call of a round must start to be handed over. */
const TOOL_CONCURRENCY = 64;

/** Why a call never got a result: the client sent none, or the bridge lost the call. */
const NO_RESULT = "No result came back for this tool call.";
const UNMATCHED_CALL = "The bridge could not match this tool call to its result.";

/**
 * Env that keeps the Claude Code CLI a plain transport. The client owns the conversation and its
 * limits: it compacts, recovers from a real overflow, and knows each model's window and output cap.
 * Left alone the CLI would compact its own copy of the conversation and refuse turns on its own
 * token estimate.
 */
export function cliPassthroughEnv(contextWindow: number, maxTokens: number) {
  const env: ClaudeEnv = {};

  env.DISABLE_COMPACT = "1";
  env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = String(CLI_BLOCKING_LIMIT_OFF);

  if (contextWindow > 0) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);

  if (maxTokens > 0) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(maxTokens));

  // A tool call waits on the client for as long as its tool runs: never move it to the background,
  // and start every call of a round at once so they all reach the client together.
  env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = "0";
  env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = String(TOOL_CONCURRENCY);

  return env;
}

/** Environment variables for a Claude Code process. */
export type ClaudeEnv = Record<string, string>;

export type BridgeOptions = {
  /** Environment for every Claude Code process: its credential, CA bundle and traffic switches. */
  readonly claudeEnv: ClaudeEnv;
  /** Empty working directory for Claude Code: the bridge never touches files. */
  readonly cwd: string;
  /** When set, every request must present it in `x-dolly-bridge-key`. */
  readonly key?: string;
};

type StoredSession = {
  sdkSessionId: string;
  /** How many client messages the SDK session has already seen, its own last reply included. */
  messageCount: number;
  /** historyDigest of the client messages it was sent, all but that reply. */
  sentDigest: string;
  /** That reply made tool calls: the SDK session's turn waits on their results. */
  awaiting: boolean;
  /** Where a new process picks the session up; none means it starts afresh with a full replay. */
  anchor: Anchor | undefined;
  lastUsedAt: number;
};

/**
 * The last Claude Code turn that finished (the model answered without tool calls) and the client
 * received. A new process resumes there and is sent the client's messages from `from` on as text,
 * so a turn that died, was abandoned or was lost mid-tool-loop is replayed once, never doubled.
 */
type Anchor = {
  sdkSessionId: string;
  /** The turn's last transcript entry. */
  at: string | undefined;
  /** How many client messages that turn covers, its reply included. */
  from: number;
};

/**
 * The conversation as the SDK session saw it: each message's role and flattened text. A request
 * that doesn't start with exactly this history (a compaction summary, an edit, or another request
 * sharing the session id such as the summarizer's) must not resume the session.
 */
function historyDigest(messages: readonly Message[]) {
  const seen = messages.map((message) => [message.role, flattenMessageText(message.content)]);

  return createHash("sha256").update(JSON.stringify(seen)).digest("hex");
}

type OutputBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject };

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

type BridgeMessage = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: OutputBlock[];
  stop_reason: "tool_use" | "end_turn";
  stop_sequence: null;
  usage: Usage;
};

function anthropicError(status: number, type: string, message: string) {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** A user message for Claude Code: the SDK only takes image blocks through SDKUserMessage. */
function userMessage(content: SDKUserMessage["message"]["content"]): SDKUserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/** The SDK's thinking options for the request's: off, adaptive at an effort, or a budget. */
function thinkingOptions(body: MessagesRequest) {
  const options: Pick<Options, "thinking" | "effort"> = {};

  if (body.thinking?.type === "disabled") options.thinking = { type: "disabled" };
  else if (body.thinking?.type === "adaptive") options.thinking = { type: "adaptive" };
  else if (body.thinking?.type === "enabled")
    options.thinking = { type: "enabled", budgetTokens: body.thinking.budget_tokens };

  if (body.output_config?.effort) options.effort = body.output_config.effort;

  return options;
}

/** Usage as the SDK or a stream event reports it, where a missing count may also be null. */
type ReportedUsage = { [Count in keyof Usage]?: number | null };

function usageFrom(usage: ReportedUsage | undefined): Usage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
  };
}

function textOf(content: readonly OutputBlock[]) {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The request body as text, or null once it passes MAX_BODY_BYTES, counted in bytes as read. */
async function readBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;

  if (!request.body) return "";

  const chunks: Uint8Array[] = [];
  let bytes = 0;

  for await (const chunk of request.body) {
    bytes += chunk.byteLength;

    // Leaving the loop cancels the rest of the body.
    if (bytes > MAX_BODY_BYTES) return null;

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

const encoder = new TextEncoder();

const sse = (event: string, data: JsonObject) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

/** Replay a finished message as the Anthropic stream events a streaming client expects. */
function messageEvents(message: BridgeMessage) {
  const events = [
    sse("message_start", {
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    }),
  ];

  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        sse("content_block_start", { index, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }),
      );
    } else {
      events.push(
        sse("content_block_start", {
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        }),
        sse("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        }),
      );
    }

    events.push(sse("content_block_stop", { index }));
  });

  events.push(
    sse("message_delta", {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    }),
    sse("message_stop", {}),
  );

  return events;
}

type Captured = { id: string; name: string; input: JsonObject };

/** What one request collects from Claude Code: one tool round, or the turn's final answer. */
type Turn = {
  content: OutputBlock[];
  limitError: string | undefined;
  /** The latest model call's usage, as Anthropic would report it for that one request. */
  usage: Usage | undefined;
};

/** A tool call's result as Claude Code hands it to the model. */
type ToolOutcome = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

/** The latest model call's tool calls, and how far each has got. */
type Round = {
  /** Its tool_use blocks, in order. */
  calls: Captured[];
  /** The model call has finished, stopping for tool use. */
  complete: boolean;
  /** The stop reason its stream reported. */
  stopReason: string | undefined;
  /** Calls Claude Code answered itself (an input it refused, an unknown tool). */
  answered: Set<string>;
  /** Calls already handed to the client. */
  handed: Set<string>;
  /** The settle backstop ran out: hand over whatever has started. */
  settled: boolean;
};

const newRound = (): Round => ({
  calls: [],
  complete: false,
  stopReason: undefined,
  answered: new Set(),
  handed: new Set(),
  settled: false,
});

/**
 * How one request is answered: on which process, by sending what, and whether that process holds
 * the session's anchor (it continues or resumes the SDK session) rather than a fresh replay.
 */
type Attempt = { live: Live; send: () => void; resumed: boolean };

/** Where a new process picks up a session: the SDK session and the entry to resume at. */
type Resume = { sdkSessionId: string; at: string | undefined };

/** The SDK's tool-call context: Claude Code names the tool_use a call answers in `_meta`. */
const ToolCallContext = z.object({
  _meta: z.object({ "claudecode/toolUseId": z.string().min(1) }),
});

/** The client's tool result as the content Claude Code hands the model. */
function toolOutcome(block: ToolResultBlock): ToolOutcome {
  const content: ToolOutcome["content"] = [];

  if (!Array.isArray(block.content)) {
    if (block.content) content.push({ type: "text", text: block.content });
  } else
    for (const inner of block.content) {
      if (inner.type === "text") content.push({ type: "text", text: inner.text });
      else if (inner.source.type === "base64")
        content.push({ type: "image", data: inner.source.data, mimeType: inner.source.media_type });
      else content.push({ type: "text", text: `[image: ${inner.source.url}]` });
    }

  // An empty result still answers the call.
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });

  return { content, isError: block.is_error === true };
}

const failedCall = (text: string): ToolOutcome => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** A queue of user messages Claude Code reads as its streaming input, open until ended. */
function inbox() {
  const queued: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;

  function poke() {
    wake?.();
    wake = undefined;
  }

  async function* messages() {
    while (!ended) {
      const next = queued.shift();

      if (next) yield next;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  return {
    messages: messages(),
    push(message: SDKUserMessage) {
      queued.push(message);
      poke();
    },
    end() {
      ended = true;
      poke();
    },
  };
}

/**
 * A Claude Code process kept running between a session's requests. Starting one costs seconds on
 * a container's CPU, so a follow-up request sends its message to the waiting process instead.
 */
type Live = {
  key: string;
  /** Digest of the options it was started with: a request that needs others gets a new process. */
  config: string;
  sdkSessionId: string | undefined;
  conversation: Query;
  input: ReturnType<typeof inbox>;
  /** The turn being answered; undefined while the process waits for the next request. */
  turn: Turn | undefined;
  /** Tool calls Claude Code has started, each waiting for the client's result. */
  calls: Map<string, (outcome: ToolOutcome) => void>;
  /** Each call's input as the PreToolUse hook saw it. */
  inputs: Map<string, JsonObject>;
  round: Round;
  /** Wakes a request waiting for the round to be ready when a call starts. */
  wake: (() => void) | undefined;
  /** The SDK message being read, kept across requests: a round can end while one is pending. */
  next: Promise<IteratorResult<SDKMessage, void>> | undefined;
  /** The latest transcript entry. */
  lastEntry: string | undefined;
  closed: boolean;
  idle: ReturnType<typeof setTimeout> | undefined;
  lastUsedAt: number;
};

export function createBridge(options: BridgeOptions) {
  const sessions = new Map<string, StoredSession>();
  const lives = new Map<string, Live>();

  function remember(key: string, session: StoredSession) {
    sessions.set(key, session);

    if (sessions.size <= MAX_SESSIONS) return;
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    for (const [stale] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(stale);
  }

  /** The client's session header, else a fingerprint of the first message so retries reuse it. */
  function sessionKey(request: Request, messages: readonly Message[]) {
    const header = request.headers.get("x-dolly-session");

    if (header) return `session:${header}`;
    const first = messages[0] ? flattenMessageText(messages[0].content) : "";

    return `fingerprint:${createHash("sha256").update(first).digest("hex").slice(0, 32)}`;
  }

  /** The options a Claude Code process is started with, fixed for its life. */
  function processOptions(request: Request, body: MessagesRequest) {
    const contextWindow = Number(request.headers.get("x-dolly-context-window") ?? 0) || 0;
    const env = { ...options.claudeEnv };

    for (const name of ["PATH", "HOME", "LANG"])
      if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, cliPassthroughEnv(contextWindow, body.max_tokens ?? 0));

    // Not the system prompt: a resumed SDK session keeps the one it started with, so a new process
    // would answer with the same prompt the waiting one has.
    const fingerprint = JSON.stringify([
      body.model,
      body.tools,
      body.thinking,
      body.output_config,
      body.max_tokens,
      contextWindow,
    ]);

    return { env, config: createHash("sha256").update(fingerprint).digest("hex") };
  }

  /** Start a Claude Code process for a session, resuming its SDK session when given one. */
  function start(key: string, request: Request, body: MessagesRequest, resume?: Resume) {
    const { env, config } = processOptions(request, body);
    const input = inbox();

    // Records each client tool's input as Claude Code will run it. Anything else is refused: only
    // the client's tools exist (an empty `tools` list is the primary switch).
    const capture: HookCallback = async (hook) => {
      if (hook.hook_event_name !== "PreToolUse") return {};

      if (!hook.tool_name.startsWith(PASSTHROUGH_PREFIX))
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `${hook.tool_name} is not available here.`,
          },
        };

      const args = ToolArguments.safeParse(hook.tool_input);

      if (args.success) live.inputs.set(hook.tool_use_id, args.data);

      return {};
    };

    // The client runs every tool: a call waits here until its result arrives with the client's
    // next request, and Claude Code hands that to the model as the call's own tool_result.
    const waitForClient = (id: string | undefined) => {
      if (id === undefined || live.closed) return Promise.resolve(failedCall(UNMATCHED_CALL));

      return new Promise<ToolOutcome>((resolve) => {
        live.calls.set(id, resolve);
        live.wake?.();
      });
    };

    const passthrough = body.tools.map((definition) =>
      tool(
        definition.name,
        definition.description || definition.name,
        toolInputSchema(definition.input_schema),
        async (_args, extra) =>
          waitForClient(ToolCallContext.safeParse(extra).data?._meta["claudecode/toolUseId"]),
        // Read-only to Claude Code means safe to run concurrently: a round's calls all start, and
        // wait, together. What a tool may really do is the client's business.
        { annotations: { readOnlyHint: true } },
      ),
    );

    const mcpServers: Options["mcpServers"] = {};

    if (passthrough.length > 0)
      mcpServers[PASSTHROUGH_MCP] = createSdkMcpServer({
        name: PASSTHROUGH_MCP,
        tools: passthrough,
      });

    const live: Live = {
      key,
      config,
      sdkSessionId: resume?.sdkSessionId,
      input,
      turn: undefined,
      calls: new Map(),
      inputs: new Map(),
      round: newRound(),
      wake: undefined,
      next: undefined,
      lastEntry: resume?.at,
      closed: false,
      idle: undefined,
      lastUsedAt: Date.now(),
      conversation: query({
        prompt: input.messages,
        options: {
          cwd: options.cwd,
          model: body.model || undefined,
          resume: resume?.sdkSessionId,
          resumeSessionAt: resume?.at,
          // A whole tool loop is one Claude Code turn: one model call per round.
          maxTurns: MAX_TURNS,
          // Stream events say when a model call has finished, so its tool calls are all known.
          includePartialMessages: true,
          ...thinkingOptions(body),
          systemPrompt: systemText(body.system) || " ",
          settingSources: [],
          mcpServers,
          strictMcpConfig: true,
          tools: [],
          disallowedTools: DISALLOWED_BUILTINS,
          allowedTools: body.tools.map((definition) => `${PASSTHROUGH_PREFIX}${definition.name}`),
          env,
          hooks: { PreToolUse: [{ matcher: "", hooks: [capture] }] },
        },
      }),
    };

    return live;
  }

  function close(live: Live) {
    if (live.closed) return;
    live.closed = true;
    clearTimeout(live.idle);

    if (lives.get(live.key) === live) lives.delete(live.key);

    const exit = () => {
      live.input.end();
      live.conversation.close();
    };

    // Not awaited: the reply never waits on the process exiting.
    if (live.calls.size === 0) {
      exit();

      return;
    }

    // Mid-tool-loop, Claude Code would answer the waiting calls as interrupted and make one more
    // model call before it exits: interrupt the turn first so it doesn't.
    live.calls.clear();
    // A process that already died never answers the interrupt.
    const gone = new Promise((resolve) => setTimeout(resolve, INTERRUPT_WAIT_MS).unref());

    void Promise.race([live.conversation.interrupt(), gone])
      .catch(() => undefined)
      .finally(exit);
  }

  /** Keep a process that just answered for its session's next request, retiring the one it replaces. */
  function keep(live: Live) {
    const current = lives.get(live.key);

    if (current && current !== live) {
      // A concurrent request is mid-turn on the kept process: it stays, this one goes.
      if (current.turn) {
        close(live);

        return;
      }

      close(current);
    }

    live.lastUsedAt = Date.now();
    live.idle = setTimeout(() => close(live), live.calls.size > 0 ? TOOL_WAIT_MS : LIVE_IDLE_MS);
    live.idle.unref();
    lives.set(live.key, live);

    if (lives.size <= MAX_LIVE) return;
    const waiting = [...lives.values()].filter((entry) => !entry.turn);

    // A process mid-tool-loop goes last: losing it means replaying the loop's rounds as text.
    waiting.sort(
      (a, b) => Number(a.calls.size > 0) - Number(b.calls.size > 0) || a.lastUsedAt - b.lastUsedAt,
    );

    for (const stale of waiting.slice(0, lives.size - MAX_LIVE)) close(stale);
  }

  /**
   * Fold one SDK message into the turn and the process's round. Returns the usage once the turn's
   * successful result arrives, throws for a failed one, and returns undefined for everything else.
   */
  function absorb(live: Live, turn: Turn, message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init")
      live.sdkSessionId = message.session_id;

    if ((message.type === "assistant" || message.type === "user") && message.uuid)
      live.lastEntry = message.uuid;

    if (message.type === "stream_event" && message.parent_tool_use_id === null) {
      const event = message.event;

      // A new model call: the round before it is over, every call answered.
      if (event.type === "message_start") {
        live.round = newRound();
        turn.usage = usageFrom(event.message.usage);
      } else if (event.type === "message_delta") {
        live.round.stopReason = event.delta.stop_reason ?? undefined;

        if (turn.usage) turn.usage.output_tokens = event.usage.output_tokens ?? 0;
      } else if (event.type === "message_stop") {
        live.round.complete = live.round.stopReason === "tool_use";
      }
    }

    if (message.type === "assistant") {
      const text = message.message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();

      if (isLimitErrorKind(message.error) && !turn.limitError && message.error)
        turn.limitError = limitErrorMessage(message.error, text);

      // Thinking can't round-trip without its signature, so only text and tool calls go back.
      for (const block of message.message.content) {
        if (block.type === "text" && block.text)
          turn.content.push({ type: "text", text: block.text });

        if (block.type === "tool_use") {
          const input = ToolArguments.safeParse(block.input);

          live.round.calls.push({
            id: block.id,
            name: block.name.startsWith(PASSTHROUGH_PREFIX)
              ? block.name.slice(PASSTHROUGH_PREFIX.length)
              : block.name,
            input: input.success ? input.data : {},
          });
        }
      }
    }

    // A result for a call that never reached the client: Claude Code answered it itself.
    if (message.type === "user" && Array.isArray(message.message.content))
      for (const block of message.message.content)
        if (
          block.type === "tool_result" &&
          !live.calls.has(block.tool_use_id) &&
          !live.round.handed.has(block.tool_use_id)
        )
          live.round.answered.add(block.tool_use_id);

    if (message.type !== "result") return undefined;
    live.sdkSessionId = message.session_id || live.sdkSessionId;

    // A limit tag on a message outranks the result's own wording.
    if (turn.limitError) throw new Error(turn.limitError);

    if (message.is_error || message.subtype !== "success") {
      // Surface SDK and API failures as errors, not assistant text: the CLI narrates errors
      // ("API Error: 400 …") as a message that would otherwise read as a model reply.
      const detail =
        (message.subtype === "success" && message.result) ||
        textOf(turn.content) ||
        (message.subtype !== "success" && message.errors.join(", ")) ||
        message.subtype;

      throw new Error(detail);
    }

    // Claude Code reports some usage limits as a successful result whose whole text is the
    // notice; treat that as the failure it is.
    const notice = (message.subtype === "success" && message.result) || textOf(turn.content);

    if (isAccountNotice(notice)) throw new Error(notice);

    return turn.usage ?? usageFrom(message.usage);
  }

  /**
   * The round's calls to hand to the client, once they can go: the model call is done and every
   * call has started (or been answered by Claude Code), or the settle backstop ran out. Undefined
   * while the round isn't ready or has nothing new for the client.
   */
  function handover(live: Live) {
    const round = live.round;

    if (!round.complete) return undefined;

    const fresh = round.calls.filter(
      (call) => live.calls.has(call.id) && !round.handed.has(call.id),
    );

    if (fresh.length === 0) return undefined;

    const started = round.calls.every(
      (call) => live.calls.has(call.id) || round.answered.has(call.id) || round.handed.has(call.id),
    );

    if (!started && !round.settled) return undefined;

    for (const call of fresh) round.handed.add(call.id);

    // The input Claude Code runs the call with, else the model's own.
    return fresh.map((call) => ({ ...call, input: live.inputs.get(call.id) ?? call.input }));
  }

  /** Whether the round is waiting only on calls Claude Code hasn't started: time for the backstop. */
  function stalled(live: Live) {
    const round = live.round;

    return (
      round.complete &&
      !round.settled &&
      round.calls.some((call) => live.calls.has(call.id) && !round.handed.has(call.id))
    );
  }

  /**
   * One request on a process: send what it carries (a user message, or the results of the tool
   * calls the process is waiting on) and read until the next round of tool calls is ready or the
   * turn's result arrives. Resolves to the reason when the process ends first (it exited, or the
   * client went away).
   */
  async function ask(live: Live, send: () => void, cancel: AbortController) {
    const turn: Turn = { content: [], limitError: undefined, usage: undefined };
    const stop = () => close(live);

    if (cancel.signal.aborted) return { ended: "request canceled" };
    clearTimeout(live.idle);
    live.turn = turn;
    cancel.signal.addEventListener("abort", stop, { once: true });
    send();

    try {
      while (true) {
        // Armed before the check: a call that starts after it still wakes this wait.
        const started = new Promise<"started">((resolve) => {
          live.wake = () => resolve("started");
        });

        const calls = handover(live);

        if (calls) return { turn, calls, usage: turn.usage ?? usageFrom(undefined) };

        if (live.closed) return { ended: "request canceled" };
        live.next ??= live.conversation.next();
        let settle: ReturnType<typeof setTimeout> | undefined;

        const waits: Array<Promise<IteratorResult<SDKMessage, void> | "started" | "settled">> = [
          live.next,
          started,
        ];

        if (stalled(live))
          waits.push(
            new Promise((resolve) => {
              settle = setTimeout(() => resolve("settled"), ROUND_SETTLE_MS);
            }),
          );

        let next: IteratorResult<SDKMessage, void> | "started" | "settled";

        try {
          next = await Promise.race(waits);
        } catch (cause) {
          return { ended: cause instanceof Error ? cause.message : String(cause) };
        } finally {
          clearTimeout(settle);
          live.wake = undefined;
        }

        if (next === "started") continue;

        if (next === "settled") {
          live.round.settled = true;
          continue;
        }

        live.next = undefined;

        if (next.done) return { ended: "Claude Code exited before answering" };
        const usage = absorb(live, turn, next.value);

        if (usage) return { turn, calls: [], usage };
      }
    } finally {
      cancel.signal.removeEventListener("abort", stop);
      live.turn = undefined;
    }
  }

  /** The tool calls the process waits on, answered from the client's tail, when they all match. */
  function deliverable(live: Live, tail: readonly Message[]) {
    const results = new Map<string, ToolResultBlock>();
    const rest: Message[] = [];

    for (const message of tail) {
      if (message.role !== "user") return undefined;

      if (!Array.isArray(message.content)) {
        rest.push(message);
        continue;
      }

      const other = message.content.filter((block) => block.type !== "tool_result");

      for (const block of message.content)
        if (block.type === "tool_result") results.set(block.tool_use_id, block);

      if (other.length > 0) rest.push({ role: "user", content: other });
    }

    // Results for these very calls, or the tail is something else (a new prompt after a stop).
    if (![...live.round.handed].some((id) => results.has(id) && live.calls.has(id)))
      return undefined;

    const extra = rest.length > 0 ? sdkTurn(rest) : undefined;

    const message =
      extra && (extra.current.trim() || extra.images.length > 0)
        ? userMessage(sdkTurnContent(extra) ?? sdkTurnText(extra))
        : undefined;

    return () => {
      // Anything sent beside the results (a steering message) joins the turn after them.
      if (message) live.input.push(message);

      for (const id of live.round.handed) {
        const resolve = live.calls.get(id);

        if (!resolve) continue;
        live.calls.delete(id);
        live.inputs.delete(id);
        const result = results.get(id);

        resolve(result ? toolOutcome(result) : failedCall(NO_RESULT));
      }
    };
  }

  async function run(request: Request, body: MessagesRequest, cancel: AbortController) {
    const key = sessionKey(request, body.messages);
    const stored = sessions.get(key);
    const config = processOptions(request, body).config;

    // Continuation: the client's history grew past what the SDK session has seen, and starts with
    // exactly what it was sent. Anything else (first request, edited or compacted history, another
    // conversation under the same session id) gets a fresh SDK session with a full replay.
    const continuation =
      stored !== undefined &&
      body.messages.length > stored.messageCount &&
      historyDigest(body.messages.slice(0, stored.messageCount - 1)) === stored.sentDigest;

    // The session's waiting process takes a continuation when it was started the same way and
    // holds the same SDK session: the tool results it waits on, or the next user message.
    const waiting = lives.get(key);

    const sameProcess =
      continuation &&
      waiting !== undefined &&
      !waiting.turn &&
      !waiting.closed &&
      waiting.sdkSessionId === stored.sdkSessionId &&
      waiting.config === config;

    const tail = continuation ? body.messages.slice(stored.messageCount) : [];
    const deliver = sameProcess && stored.awaiting ? deliverable(waiting, tail) : undefined;
    const pushable = sameProcess && !stored.awaiting && waiting.calls.size === 0;

    /** What a new process is sent, and where it resumes: the anchor, else a fresh full replay. */
    function restart() {
      const anchor = continuation && stored ? stored.anchor : undefined;
      const prompt = sdkTurn(body.messages, anchor?.from ?? 0);
      const message = userMessage(sdkTurnContent(prompt) ?? sdkTurnText(prompt));
      const resume = anchor ? { sdkSessionId: anchor.sdkSessionId, at: anchor.at } : undefined;

      // Never two processes on one session: a waiting one (mid-tool-loop or not) goes first.
      if (waiting && !waiting.turn) close(waiting);
      const live = start(key, request, body, resume);

      return { live, send: () => live.input.push(message), resumed: anchor !== undefined };
    }

    let attempt: Attempt;

    if (deliver) attempt = { live: waiting!, send: deliver, resumed: true };
    else if (pushable) {
      const prompt = sdkTurn(body.messages, stored.messageCount);
      const message = userMessage(sdkTurnContent(prompt) ?? sdkTurnText(prompt));

      attempt = { live: waiting!, send: () => waiting!.input.push(message), resumed: true };
    } else attempt = restart();

    let answer = await ask(attempt.live, attempt.send, cancel).catch((cause: Error) => {
      close(attempt.live);
      throw cause;
    });

    // A waiting process can have exited, idle or mid-turn: answer on a fresh one resuming the
    // session at the last turn the client received, so the lost turn is replayed, not doubled.
    if ("ended" in answer && (deliver || pushable) && !cancel.signal.aborted) {
      close(attempt.live);
      attempt = restart();
      answer = await ask(attempt.live, attempt.send, cancel).catch((cause: Error) => {
        close(attempt.live);
        throw cause;
      });
    }

    const live = attempt.live;

    if ("ended" in answer) {
      close(live);
      throw new Error(answer.ended);
    }

    const { turn, calls, usage } = answer;

    keep(live);

    if (live.sdkSessionId) {
      // A finished turn is the new anchor. Mid-loop the anchor stays the last finished turn of this
      // SDK session, if the process resumed one; a loop from a fresh replay has none to go back to.
      const previous = attempt.resumed && stored ? stored.anchor : undefined;

      const anchor: Anchor | undefined =
        calls.length === 0
          ? { sdkSessionId: live.sdkSessionId, at: live.lastEntry, from: body.messages.length + 1 }
          : previous;

      // +1: the assistant message returned now is in the client's history on its next request.
      remember(key, {
        sdkSessionId: live.sdkSessionId,
        messageCount: body.messages.length + 1,
        sentDigest: historyDigest(body.messages),
        awaiting: calls.length > 0,
        anchor,
        lastUsedAt: Date.now(),
      });
    }

    const content = [...turn.content];

    for (const call of calls) content.push({ type: "tool_use", ...call });

    const reply: BridgeMessage = {
      id: `msg_bridge_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage,
    };

    return reply;
  }

  async function messages(request: Request) {
    if (options.key && request.headers.get("x-dolly-bridge-key") !== options.key)
      return anthropicError(401, "authentication_error", "invalid bridge key");

    const raw = await readBody(request);

    if (raw === null)
      return anthropicError(
        413,
        "request_too_large",
        `request body exceeds ${MAX_BODY_BYTES} bytes`,
      );

    let json: ReturnType<typeof JSON.parse>;

    try {
      json = JSON.parse(raw);
    } catch {
      return anthropicError(400, "invalid_request_error", "invalid JSON body");
    }

    const parsed = MessagesRequest.safeParse(json);

    if (!parsed.success)
      return anthropicError(400, "invalid_request_error", `bridge: ${parsed.error.message}`);
    const body = parsed.data;

    // A client that disconnects (a stopped turn) ends the request: a running query is stopped, so
    // a canceled turn bills nothing more.
    const cancel = new AbortController();

    if (request.signal.aborted) cancel.abort();
    else request.signal.addEventListener("abort", () => cancel.abort(), { once: true });

    if (!body.stream) {
      try {
        return Response.json(await run(request, body, cancel));
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));

        // Non-retryable status: SDK failures here are configuration or limit shaped, and a
        // retryable one would only make the client loop on them.
        return anthropicError(400, "invalid_request_error", errorText(error));
      }
    }

    // Streaming: open the stream at once, ping while the SDK works (keeping client idle timeouts
    // at bay), then replay the finished message as Anthropic stream events.
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        clearInterval(heartbeat);
        cancel.abort();
      },
      start(controller) {
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(sse("ping", {}));
          } catch {
            clearInterval(heartbeat);
          }
        }, HEARTBEAT_MS);

        void run(request, body, cancel).then(
          (reply) => {
            clearInterval(heartbeat);

            try {
              for (const event of messageEvents(reply)) controller.enqueue(event);
              controller.close();
            } catch {
              // The client went away; nothing is left to deliver.
            }
          },
          (cause: Error | string) => {
            clearInterval(heartbeat);
            const error = cause instanceof Error ? cause : new Error(cause);

            try {
              controller.enqueue(
                sse("error", { error: { type: "api_error", message: errorText(error) } }),
              );
              controller.close();
            } catch {
              // The client went away; nothing is left to deliver.
            }
          },
        );
      },
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  return {
    /** Stop every waiting Claude Code process. */
    close() {
      for (const live of lives.values()) close(live);
    },
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") return Response.json({ ok: true });

      if (request.method !== "POST" || url.pathname !== "/v1/messages")
        return anthropicError(
          404,
          "not_found_error",
          `no such endpoint: ${request.method} ${url.pathname}`,
        );

      return messages(request);
    },
  };
}

function errorText(error: Error) {
  return error.message;
}

export type { BridgeMessage };
