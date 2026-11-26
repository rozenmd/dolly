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
 *  - A PreToolUse hook blocks every tool call and captures it. The captured calls return to the
 *    client as Anthropic `tool_use` blocks with stop_reason "tool_use": the client (Dolly) runs the
 *    tool itself.
 *  - Each client session maps to one SDK session, keyed by the `x-dolly-session` header (else a
 *    fingerprint of the first message). A follow-up request resumes that session with only the new
 *    tail; a diverged or compacted history starts a fresh session with a full flat-text replay.
 *  - Only the current user turn's images reach the SDK, as structured content.
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

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_SESSIONS = 500;
const HEARTBEAT_MS = 15_000;

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
  /** How many client messages the SDK session has already seen. */
  messageCount: number;
  lastUsedAt: number;
};

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

/** A one-message streaming input: the SDK only takes image blocks through SDKUserMessage. */
async function* singleUserMessage(content: SDKUserMessage["message"]["content"]) {
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };

  yield message;
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

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const text = await request.text();

  return text.length > MAX_BODY_BYTES ? null : text;
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

export function createBridge(options: BridgeOptions) {
  const sessions = new Map<string, StoredSession>();

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

  async function run(request: Request, body: MessagesRequest, cancel: AbortController) {
    const key = sessionKey(request, body.messages);
    const stored = sessions.get(key);
    // Continuation: the client's history grew past what the SDK session has seen. Anything else
    // (first request, edited or compacted history) gets a fresh SDK session with a full replay.
    const continuation = stored !== undefined && body.messages.length > stored.messageCount;
    const turn = sdkTurn(body.messages, continuation ? stored.messageCount : 0);
    const prompt = sdkTurnText(turn);
    const promptContent = sdkTurnContent(turn);
    const captured: Array<{ id: string; name: string; input: JsonObject }> = [];

    const capture: HookCallback = async (input) => {
      if (input.hook_event_name === "PreToolUse") {
        const name = input.tool_name.startsWith(PASSTHROUGH_PREFIX)
          ? input.tool_name.slice(PASSTHROUGH_PREFIX.length)
          : input.tool_name;

        const args = ToolArguments.safeParse(input.tool_input);

        captured.push({ id: input.tool_use_id, name, input: args.success ? args.data : {} });
      }

      return { decision: "block", reason: BLOCK_REASON };
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

    const contextWindow = Number(request.headers.get("x-dolly-context-window") ?? 0) || 0;
    const env = { ...options.claudeEnv };

    for (const name of ["PATH", "HOME", "LANG"])
      if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, cliPassthroughEnv(contextWindow, body.max_tokens ?? 0));

    const content: OutputBlock[] = [];
    let usage = usageFrom(undefined);
    let sdkSessionId = continuation ? stored.sdkSessionId : undefined;
    let limitError: string | undefined;

    const conversation = query({
      prompt: promptContent ? singleUserMessage(promptContent) : prompt,
      options: {
        cwd: options.cwd,
        abortController: cancel,
        model: body.model || undefined,
        resume: sdkSessionId,
        // Turn 1 is the real answer; turn 2 exists because blocked tool calls count as a turn
        // boundary (the hook's reason tells the model to stop). A model that keeps going is
        // handled at the result: error_max_turns with captured calls returns them as tool_use.
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
    });

    for await (const message of conversation) {
      if (message.type === "system" && message.subtype === "init")
        sdkSessionId = message.session_id;

      if (message.type === "assistant") {
        const text = message.message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n")
          .trim();

        if (isLimitErrorKind(message.error) && !limitError && message.error)
          limitError = limitErrorMessage(message.error, text);

        // Text only: tool_use blocks come from `captured` (after the hook, so a blocked and
        // retried call is never doubled), and thinking can't round-trip without its signature.
        for (const block of message.message.content)
          if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
      }

      if (message.type !== "result") continue;
      sdkSessionId = message.session_id || sdkSessionId;

      // A limit tag on a message outranks the result's own wording.
      if (limitError) throw new Error(limitError);

      // error_max_turns with captured calls is a success here: models that answer a blocked call
      // by trying the next tool blow the turn cap; the captured calls are the point.
      const maxTurnsWithCaptures = message.subtype === "error_max_turns" && captured.length > 0;

      if ((message.is_error || message.subtype !== "success") && !maxTurnsWithCaptures) {
        // Surface SDK and API failures as errors, not assistant text: the CLI narrates errors
        // ("API Error: 400 …") as a message that would otherwise read as a model reply.
        const detail =
          (message.subtype === "success" && message.result) ||
          textOf(content) ||
          (message.subtype !== "success" && message.errors.join(", ")) ||
          message.subtype;

        throw new Error(detail);
      }

      // Claude Code reports some usage limits as a successful result whose whole text is the
      // notice; treat that as the failure it is.
      const notice = (message.subtype === "success" && message.result) || textOf(content);

      if (captured.length === 0 && isAccountNotice(notice)) throw new Error(notice);
      usage = usageFrom(message.usage);
      break;
    }

    if (sdkSessionId)
      // +1: the assistant message returned now is in the client's history on its next request.
      remember(key, {
        sdkSessionId,
        messageCount: body.messages.length + 1,
        lastUsedAt: Date.now(),
      });

    for (const call of captured) content.push({ type: "tool_use", ...call });

    const reply: BridgeMessage = {
      id: `msg_bridge_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: captured.length > 0 ? "tool_use" : "end_turn",
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
