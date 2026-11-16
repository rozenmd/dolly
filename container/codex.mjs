import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;

  if (value !== null && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`)
      .join(", ")}}`;

  return JSON.stringify(value);
}

function diagnosticText(text, token = "") {
  let safe = String(text);

  if (token) safe = safe.split(token).join("[redacted]");

  return safe
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted JWT]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /((?:access_token|refresh_token|id_token|authorization)["'\s]*[:=]["'\s]*)([^"'\s,}]+)/gi,
      "$1[redacted]",
    )
    .slice(-8192);
}

// Each Pi generation gets an ephemeral CLI thread. Dolly's durable transcript and
// tool scheduler remain authoritative, including after eviction or cancellation.
// Only an access token enters this container, never the rotating refresh token.
export async function runCodex(
  request,
  emit,
  { signal, binary = "codex", config = {}, onDiagnostic = () => {} } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "dolly-codex-"));
  // CLI model defaults can force Code Mode and native subagents even when their
  // feature flags are off. This transport uses Dolly's durable tools instead.
  // Give the CLI an explicit catalog for this generation's tool capabilities.
  const catalog = join(home, "models.json");
  await writeFile(
    catalog,
    JSON.stringify({
      models: [
        {
          slug: request.body.model,
          display_name: request.body.model,
          description: "Dolly-managed tools",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ].map((effort) => ({ effort, description: effort })),
          shell_type: "disabled",
          visibility: "list",
          supported_in_api: true,
          priority: 0,
          base_instructions: "",
          tool_mode: "direct",
          multi_agent_version: "disabled",
          apply_patch_tool_type: null,
          experimental_supported_tools: [],
          supports_parallel_tool_calls: false,
          supports_reasoning_summaries: true,
          support_verbosity: true,
          default_verbosity: "low",
          context_window: request.contextWindow ?? 128000,
          input_modalities: ["text", "image"],
          truncation_policy: { mode: "tokens", limit: 10000 },
        },
      ],
    }),
  );

  const settings = {
    model_catalog_json: catalog,
    agents: { enabled: false },
    tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
    include_environment_context: false,
    include_collaboration_mode_instructions: false,
    features: {
      shell_tool: false,
      unified_exec: false,
      multi_agent: false,
      multi_agent_v2: false,
      code_mode_host: false,
      code_mode: false,
      goals: false,
      hooks: false,
      apps: false,
      plugins: false,
      browser_use: false,
      computer_use: false,
      image_generation: false,
      view_image: false,
      skill_search: false,
      sleep_tool: false,
    },
    web_search: "disabled",
    ...config,
  };

  let child;
  let lines;
  let timer;
  let stage = "prepare";
  let stderr = "";
  let exitCode = null;
  let exitSignal = null;
  const stderrDecoder = new TextDecoder();
  const pending = new Map();
  let sequence = 0;
  let finished = false;
  let resolveTurn;
  let rejectTurn;

  const turn = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });

  // A startup failure can reject this before setup reaches await turn.
  void turn.catch(() => {});

  const fail = (error) => {
    if (!finished) {
      finished = true;
      rejectTurn(error);
    }

    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  const abort = () => {
    fail(new Error("Codex request cancelled"));
    child?.kill("SIGTERM");
  };

  try {
    if (signal?.aborted) throw new Error("Codex request cancelled");
    const claims = JSON.parse(Buffer.from(request.accessToken.split(".")[1], "base64url"));
    const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;

    if (!account) throw new Error("Codex access token has no ChatGPT account ID");
    const body = request.body;

    const tools = new Map(
      (body.tools ?? []).map((tool) => {
        if (tool.type !== "function") throw new Error("Unsupported Codex tool schema");

        return [`dolly_${tool.name}`, tool];
      }),
    );

    child = spawn(
      binary,
      [
        ...Object.entries(settings).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]),
        "app-server",
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: home,
          // Don't inherit host provider keys, proxy settings, or another CLI login.
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    // Retain a bounded tail, redact it before logging, and never send it to the model.
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-65536);
    });
    child.stdin.on("error", () => fail(new Error("Codex CLI transport closed")));
    child.on("error", () => fail(new Error("Unable to start Codex CLI")));
    child.on("exit", (code, termination) => {
      exitCode = code;
      exitSignal = termination;
      fail(new Error("Codex CLI exited before completing the request"));
    });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      fail(new Error("Codex CLI request timed out"));
      child.kill("SIGTERM");
    }, request.timeoutMs ?? 120_000);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        stage = method;
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });

    const output = [];
    const slots = new Map();
    let usage;
    const responseId = `resp_${crypto.randomUUID()}`;

    const slot = (id, type) => {
      if (!slots.has(id)) {
        const index = output.length;

        const item =
          type === "message"
            ? { id, type, role: "assistant", content: [] }
            : { id, type: "reasoning", summary: [] };

        slots.set(id, index);
        output.push(item);
        emit({ type: "response.output_item.added", output_index: index, item });
      }

      return slots.get(id);
    };

    const complete = () => {
      if (finished) return;
      finished = true;
      emit({
        type: "response.completed",
        response: { id: responseId, status: "completed", output, usage },
      });
      resolveTurn();
    };

    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);

        if (message.id !== undefined && !message.method) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);

          if (message.error)
            waiter?.reject(
              new Error(
                `Codex app-server error ${message.error.code}: ${diagnosticText(message.error.message, request.accessToken)}`,
              ),
            );
          else waiter?.resolve(message.result);

          return;
        }

        if (finished) return;

        const params = message.params ?? {};

        if (message.method === "item/tool/call") {
          const tool = tools.get(params.tool);

          if (!tool) throw new Error("Codex requested an unregistered Dolly tool");

          const item = {
            id: params.callId,
            call_id: params.callId,
            type: "function_call",
            name: tool.name,
            arguments: JSON.stringify(params.arguments),
          };

          output.push(item);
          emit({ type: "response.output_item.done", output_index: output.length - 1, item });
          // Don't execute or acknowledge the call here. Pi persists and executes
          // it exactly once, then supplies the result in the next generation.
          complete();
        } else if (message.id !== undefined && message.method) {
          // In particular, never independently refresh externally managed auth.
          send({
            id: message.id,
            error: { code: -32601, message: "Operation must be handled by Dolly" },
          });
          throw new Error(`Codex requested unsupported host operation: ${message.method}`);
        } else if (message.method === "item/agentMessage/delta") {
          const index = slot(params.itemId, "message");
          emit({ type: "response.output_text.delta", output_index: index, delta: params.delta });
        } else if (message.method === "item/reasoning/summaryTextDelta") {
          const index = slot(params.itemId, "reasoning");
          emit({
            type: "response.reasoning_summary_text.delta",
            output_index: index,
            delta: params.delta,
          });
        } else if (message.method === "rawResponseItem/completed") {
          const item = params.item;

          if ((item.type === "message" && item.role === "assistant") || item.type === "reasoning") {
            const id = item.id ?? `item_${output.length}`;
            const index = slot(id, item.type);
            output[index] = { ...item, id };
            emit({ type: "response.output_item.done", output_index: index, item: output[index] });
          }
        } else if (message.method === "thread/tokenUsage/updated") {
          const tokens = params.tokenUsage.last;
          usage = {
            input_tokens: tokens.inputTokens,
            output_tokens: tokens.outputTokens,
            total_tokens: tokens.totalTokens,
            input_tokens_details: { cached_tokens: tokens.cachedInputTokens },
          };
        } else if (message.method === "account/rateLimits/updated") {
          const headers = {};

          for (const [name, window] of [
            ["primary", params.rateLimits.primary],
            ["secondary", params.rateLimits.secondary],
          ]) {
            if (!window) continue;

            headers[`x-codex-${name}-used-percent`] = String(window.usedPercent);
            headers[`x-codex-${name}-window-minutes`] = String(window.windowDurationMins);
            headers[`x-codex-${name}-reset-at`] = String(window.resetsAt);
          }

          emit({ type: "dolly.codex.usage", headers });
        } else if (message.method === "turn/completed") {
          if (params.turn.status !== "completed")
            throw new Error(
              `Codex turn ${params.turn.status}: ${diagnosticText(params.turn.error?.message ?? "No error detail", request.accessToken)}`,
            );
          complete();
        } else if (message.method === "error" && !params.willRetry) {
          throw new Error(
            `Codex inference failed: ${diagnosticText(
              params.error?.message ?? "No error detail",
              request.accessToken,
            )}`,
          );
        }
      } catch (error) {
        fail(error);
      }
    });
    await rpc("initialize", {
      clientInfo: { name: "dolly", title: "Dolly", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });
    await rpc("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: request.accessToken,
      chatgptAccountId: account,
    });

    const started = await rpc("thread/start", {
      model: body.model,
      ephemeral: true,
      environments: [],
      experimentalRawEvents: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: body.instructions,
      developerInstructions:
        "You are running inside Dolly. Use only the dolly_* tools for repository access, commands, delegation and all other actions. Those tools run in the active repository sandbox. Never use local tools or inspect this transport container.",
      dynamicTools: [...tools].map(([name, tool]) => ({
        type: "function",
        name,
        description: tool.description ?? "",
        inputSchema: tool.parameters,
      })),
      config: settings,
    });

    const threadId = started.thread.id;

    const history = (body.input ?? []).map((item) =>
      item.type === "function_call" ? { ...item, name: `dolly_${item.name}` } : item,
    );

    await rpc("thread/inject_items", { threadId, items: history });
    emit({ type: "response.created", response: { id: responseId, status: "in_progress" } });
    await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "Continue from the conversation above." }],
      effort: body.reasoning?.effort,
      summary: body.reasoning?.summary,
    });
    await turn;
  } catch (error) {
    onDiagnostic({
      event: "codex_cli_failed",
      stage,
      message: diagnosticText(error.message, request.accessToken),
      stderr: diagnosticText(stderr, request.accessToken),
      exitCode,
      signal: exitSignal,
    });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    lines?.close();

    if (child) {
      child.stdin.destroy();
      child.kill("SIGTERM");
      // Bound shutdown even if the CLI is stuck in network IO.
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);

      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once("exit", resolve));
      clearTimeout(kill);
    }

    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new AbortController();
  process.on("SIGTERM", () => abort.abort());
  let input = "";
  let token = "";

  for await (const chunk of process.stdin) {
    input += chunk;

    if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new Error("Codex input too large");
  }

  try {
    const request = JSON.parse(input);

    token = request.accessToken;
    await runCodex(
      request,
      (event) => {
        process.stdout.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      {
        signal: abort.signal,
        onDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`),
      },
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "codex_bridge_failed",
        message: diagnosticText(error.message, token),
      })}\n`,
    );
    // Don't serialize raw exceptions or stderr, which may contain credentials.
    process.stdout.write(
      `data: ${JSON.stringify({
        type: "error",
        message: "Codex CLI request failed",
      })}\n\n`,
    );
    process.exitCode = 1;
  }
}
