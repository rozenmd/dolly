/**
 * Anthropic bridge: an endpoint that speaks the Anthropic Messages API (`POST /v1/messages`,
 * streaming included) but is served by the official Claude Agent SDK, so Dolly's Claude requests
 * are real Claude Code traffic on the owner's subscription.
 *
 * A port of Open Session's anthropic-bridge.ts (MIT, see third_party/opensession/LICENSE), which
 * reimplements the mapping pioneered by Pi-with-claude and @rynfar/meridian:
 *
 *  - The client's tools are registered as an in-process SDK MCP server with no-op handlers, so the
 *    model emits real tool_use blocks for them.
 *  - A PreToolUse hook blocks every tool call, captures it and ends the turn there, so a tool step
 *    is one model call. The captured calls return to the client as Anthropic `tool_use` blocks
 *    with stop_reason "tool_use": the client (Dolly) runs the tool itself.
 *  - Each client session maps to one SDK session, keyed by the `x-dolly-session` header (else a
 *    fingerprint of the first message). A follow-up request resumes that session with only the new
 *    tail; a diverged or compacted history starts a fresh session with a full flat-text replay.
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

const BLOCK_REASON =
  "This tool call was forwarded to the client for execution; its result arrives in a future turn. " +
  "Do not retry it, do not call more tools, do not add text — end your turn now.";

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
  lastUsedAt: number;
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

function usageFrom(usage: Partial<Usage> | undefined): Usage {
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

/** What one request's turn collects from Claude Code. */
type Turn = { captured: Captured[]; content: OutputBlock[]; limitError: string | undefined };

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
  function start(key: string, request: Request, body: MessagesRequest, resume?: string) {
    const { env, config } = processOptions(request, body);
    const input = inbox();

    const capture: HookCallback = async (hook) => {
      if (hook.hook_event_name === "PreToolUse") {
        const name = hook.tool_name.startsWith(PASSTHROUGH_PREFIX)
          ? hook.tool_name.slice(PASSTHROUGH_PREFIX.length)
          : hook.tool_name;

        const args = ToolArguments.safeParse(hook.tool_input);

        live.turn?.captured.push({
          id: hook.tool_use_id,
          name,
          input: args.success ? args.data : {},
        });
      }

      // Block the call and end the turn there: without `continue: false` Claude Code sends the
      // blocked result back for a second model call, seconds and tokens that only produce
      // narration about the block. Every call of the message is captured before the turn ends.
      return { continue: false, stopReason: BLOCK_REASON, decision: "block", reason: BLOCK_REASON };
    };

    const passthrough = body.tools.map((definition) =>
      tool(
        definition.name,
        definition.description || definition.name,
        toolInputSchema(definition.input_schema),
        async () => ({ content: [{ type: "text", text: "forwarded to client" }] }),
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
      sdkSessionId: resume,
      input,
      turn: undefined,
      closed: false,
      idle: undefined,
      lastUsedAt: Date.now(),
      conversation: query({
        prompt: input.messages,
        options: {
          cwd: options.cwd,
          model: body.model || undefined,
          resume,
          // Turn 1 is the answer: the hook ends the turn at a tool call. The cap is a backstop
          // for a model that keeps going; error_max_turns with captured calls returns them.
          maxTurns: 2,
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
    live.input.end();
    // Not awaited: the reply never waits on the process exiting.
    live.conversation.close();

    if (lives.get(live.key) === live) lives.delete(live.key);
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
    live.idle = setTimeout(() => close(live), LIVE_IDLE_MS);
    live.idle.unref();
    lives.set(live.key, live);

    if (lives.size <= MAX_LIVE) return;
    const waiting = [...lives.values()].filter((entry) => !entry.turn);

    waiting.sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    for (const stale of waiting.slice(0, lives.size - MAX_LIVE)) close(stale);
  }

  /**
   * Fold one SDK message into the turn. Returns the usage once the turn's successful result
   * arrives, throws for a failed one, and returns undefined for everything before it.
   */
  function absorb(live: Live, turn: Turn, message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init")
      live.sdkSessionId = message.session_id;

    if (message.type === "assistant") {
      const text = message.message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();

      if (isLimitErrorKind(message.error) && !turn.limitError && message.error)
        turn.limitError = limitErrorMessage(message.error, text);

      // Text only: tool_use blocks come from the captured calls (after the hook, so a blocked and
      // retried call is never doubled), and thinking can't round-trip without its signature.
      for (const block of message.message.content)
        if (block.type === "text" && block.text)
          turn.content.push({ type: "text", text: block.text });
    }

    if (message.type !== "result") return undefined;
    live.sdkSessionId = message.session_id || live.sdkSessionId;

    // A limit tag on a message outranks the result's own wording.
    if (turn.limitError) throw new Error(turn.limitError);

    // error_max_turns with captured calls is a success here: models that answer a blocked call
    // by trying the next tool blow the turn cap; the captured calls are the point.
    const maxTurnsWithCaptures = message.subtype === "error_max_turns" && turn.captured.length > 0;

    if ((message.is_error || message.subtype !== "success") && !maxTurnsWithCaptures) {
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

    if (turn.captured.length === 0 && isAccountNotice(notice)) throw new Error(notice);

    return usageFrom(message.usage);
  }

  /**
   * One request's turn on a process: send the user message and read until its result. Resolves
   * to the reason when the process ends first (it exited, or the client went away).
   */
  async function ask(live: Live, message: SDKUserMessage, cancel: AbortController) {
    const turn: Turn = { captured: [], content: [], limitError: undefined };
    const stop = () => close(live);

    if (cancel.signal.aborted) return { ended: "request canceled" };
    clearTimeout(live.idle);
    live.turn = turn;
    cancel.signal.addEventListener("abort", stop, { once: true });
    live.input.push(message);

    try {
      while (true) {
        let next: IteratorResult<SDKMessage, void>;

        try {
          next = await live.conversation.next();
        } catch (cause) {
          return { ended: cause instanceof Error ? cause.message : String(cause) };
        }

        if (next.done) return { ended: "Claude Code exited before answering" };
        const usage = absorb(live, turn, next.value);

        if (usage) return { turn, usage };
      }
    } finally {
      cancel.signal.removeEventListener("abort", stop);
      live.turn = undefined;
    }
  }

  async function run(request: Request, body: MessagesRequest, cancel: AbortController) {
    const key = sessionKey(request, body.messages);
    const stored = sessions.get(key);

    // Continuation: the client's history grew past what the SDK session has seen, and starts with
    // exactly what it was sent. Anything else (first request, edited or compacted history, another
    // conversation under the same session id) gets a fresh SDK session with a full replay.
    const continuation =
      stored !== undefined &&
      body.messages.length > stored.messageCount &&
      historyDigest(body.messages.slice(0, stored.messageCount - 1)) === stored.sentDigest;

    const prompt = sdkTurn(body.messages, continuation ? stored.messageCount : 0);
    const message = userMessage(sdkTurnContent(prompt) ?? sdkTurnText(prompt));

    // A continuation goes to the session's waiting process when it was started the same way and
    // holds the same SDK session; else a new process resumes the session (or starts afresh).
    const waiting = lives.get(key);

    const reusable =
      continuation &&
      waiting !== undefined &&
      !waiting.turn &&
      !waiting.closed &&
      waiting.sdkSessionId === stored.sdkSessionId &&
      waiting.config === processOptions(request, body).config;

    const resume = continuation ? stored.sdkSessionId : undefined;
    let live = reusable ? waiting : start(key, request, body, resume);

    let answer = await ask(live, message, cancel).catch((cause: Error) => {
      close(live);
      throw cause;
    });

    // A waiting process can have exited while idle: answer on a fresh one resuming the session.
    if ("ended" in answer && reusable && !cancel.signal.aborted) {
      close(live);
      live = start(key, request, body, resume);
      answer = await ask(live, message, cancel).catch((cause: Error) => {
        close(live);
        throw cause;
      });
    }

    if ("ended" in answer) {
      close(live);
      throw new Error(answer.ended);
    }

    const { turn, usage } = answer;

    keep(live);

    if (live.sdkSessionId)
      // +1: the assistant message returned now is in the client's history on its next request.
      remember(key, {
        sdkSessionId: live.sdkSessionId,
        messageCount: body.messages.length + 1,
        sentDigest: historyDigest(body.messages),
        lastUsedAt: Date.now(),
      });

    const content = [...turn.content];

    for (const call of turn.captured) content.push({ type: "tool_use", ...call });

    const reply: BridgeMessage = {
      id: `msg_bridge_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: turn.captured.length > 0 ? "tool_use" : "end_turn",
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
