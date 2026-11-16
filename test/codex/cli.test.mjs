import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { runCodex } from "../../container/codex.mjs";

const binary = process.env.CODEX_BIN ?? "codex";

const accessToken = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({
    exp: 9_999_999_999,
    "https://api.openai.com/auth": { chatgpt_account_id: "dolly-fixture" },
  }),
).toString("base64url")}.signature`;

// Real official CLI, real stdio JSON-RPC, real HTTP model endpoint. Only model
// inference is simulated; no subscription, provider endpoint or login is used.
test("official CLI replays Dolly history, streams text, and returns tools to Dolly", async () => {
  const requests = [];
  let mode = "answer";
  let onRequest;

  let answer = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "Container answer", annotations: [] }],
  };

  const reasoning = {
    id: "rs_fixture",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Fixture reasoning" }],
    encrypted_content: "fixture-encrypted-reasoning",
  };

  const server = createServer(async (request, response) => {
    if (request.method === "GET" || !request.url.includes("/responses")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: [] }));

      return;
    }

    let input = "";

    for await (const chunk of request) input += chunk;
    requests.push({ headers: request.headers, body: JSON.parse(input) });
    onRequest?.();

    if (mode === "stall") return;

    if (mode === "error") {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Denied ${accessToken}` } }));

      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1999999999",
    });

    const events = [
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        item_id: reasoning.id,
        summary_index: 0,
        delta: "Fixture reasoning",
      },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...answer, content: [] } },
      ...(answer.type === "message"
        ? [
            {
              type: "response.output_text.delta",
              output_index: 1,
              item_id: answer.id,
              delta: "Container answer",
            },
          ]
        : []),
      { type: "response.output_item.done", output_index: 1, item: answer },
      {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          status: "completed",
          output: [reasoning, answer],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_tokens_details: { cached_tokens: 20 },
          },
        },
      },
    ];

    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const config = {
    chatgpt_base_url: `http://127.0.0.1:${server.address().port}`,
    model_provider: "fixture",
    "model_providers.fixture": {
      name: "Local fixture",
      base_url: `http://127.0.0.1:${server.address().port}/v1`,
      wire_api: "responses",
      requires_openai_auth: true,
      supports_websockets: false,
      request_max_retries: 0,
      stream_max_retries: 0,
    },
    "features.enable_request_compression": false,
  };

  const body = {
    model: "gpt-6-luna",
    instructions: "You are Dolly.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Original user request" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "shell",
        description: "Run a command in the repository",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ],
  };

  try {
    const events = [];
    await runCodex({ accessToken, body, timeoutMs: 15_000 }, (event) => events.push(event), {
      binary,
      config,
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].headers["user-agent"], /dolly\/0\.157\.0/);
    assert.equal(requests[0].headers.authorization, `Bearer ${accessToken}`);
    assert.match(JSON.stringify(requests[0].body.input), /Original user request/);
    assert.ok(JSON.stringify(requests[0].body).includes("dolly_shell"));

    const advertised =
      requests[0].body.tools ??
      requests[0].body.input
        .filter((item) => item.type === "additional_tools")
        .flatMap((item) => item.tools);

    assert.deepEqual(
      advertised.map((tool) => tool.name),
      ["dolly_shell"],
    );
    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(events.at(-1).response.usage.input_tokens, 100);
    assert.equal(
      events.find((event) => event.type === "dolly.codex.usage").headers[
        "x-codex-primary-used-percent"
      ],
      "42",
    );
    assert.equal(
      events.at(-1).response.output.find((item) => item.type === "reasoning").encrypted_content,
      reasoning.encrypted_content,
    );
    assert.equal(events.at(-1).response.output.filter((item) => item.type === "message").length, 1);
    assert.equal(
      events
        .at(-1)
        .response.output.filter((item) => item.type === "message")
        .at(-1).content[0].text,
      "Container answer",
    );

    answer = {
      id: "fc_fixture",
      type: "function_call",
      call_id: "call_fixture",
      name: "dolly_shell",
      arguments: JSON.stringify({ command: "echo fixture" }),
    };
    const toolEvents = [];
    await runCodex({ accessToken, body, timeoutMs: 15_000 }, (event) => toolEvents.push(event), {
      binary,
      config,
    });
    const tool = toolEvents.at(-1).response.output.find((item) => item.type === "function_call");
    assert.equal(tool.name, "shell");
    assert.equal(tool.call_id, "call_fixture");
    assert.deepEqual(JSON.parse(tool.arguments), { command: "echo fixture" });
    assert.equal(
      requests.length,
      2,
      "CLI must not execute the tool or start another model request",
    );

    answer = {
      id: "msg_after_tool",
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Container answer", annotations: [] }],
    };
    await runCodex(
      {
        accessToken,
        timeoutMs: 15_000,
        body: {
          ...body,
          input: [
            ...body.input,
            reasoning,
            tool,
            { type: "function_call_output", call_id: tool.call_id, output: "fixture\n" },
          ],
        },
      },
      () => {},
      { binary, config },
    );
    assert.ok(
      requests[2].body.input.some(
        (item) => item.type === "function_call" && item.name === "dolly_shell",
      ),
    );
    assert.ok(
      requests[2].body.input.some(
        (item) => item.type === "function_call_output" && item.output === "fixture\n",
      ),
    );

    mode = "error";
    const diagnostics = [];

    await assert.rejects(
      runCodex({ accessToken, body, timeoutMs: 15_000 }, () => {}, {
        binary,
        config,
        onDiagnostic: (entry) => diagnostics.push(entry),
      }),
      (error) => !error.message.includes(accessToken) && /Codex/.test(error.message),
    );
    assert.equal(diagnostics[0].event, "codex_cli_failed");
    assert.equal(diagnostics[0].stage, "turn/start");
    assert.match(diagnostics[0].message, /403/);
    assert.ok(!JSON.stringify(diagnostics).includes(accessToken));

    const startupDiagnostics = [];

    await assert.rejects(
      runCodex({ accessToken, body, timeoutMs: 15_000 }, () => {}, {
        binary,
        config: { ...config, tools: { update_plan: false } },
        onDiagnostic: (entry) => startupDiagnostics.push(entry),
      }),
      /exited/,
    );
    assert.equal(startupDiagnostics[0].exitCode, 1);
    assert.match(startupDiagnostics[0].stderr, /invalid type/);
    assert.ok(!JSON.stringify(startupDiagnostics).includes(accessToken));

    mode = "stall";
    const controller = new AbortController();

    const waiting = new Promise((resolve) => {
      onRequest = resolve;
    });

    const cancelled = runCodex({ accessToken, body, timeoutMs: 15_000 }, () => {}, {
      binary,
      config,
      signal: controller.signal,
    });

    await waiting;
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    onRequest = undefined;
    await assert.rejects(
      runCodex({ accessToken, body, timeoutMs: 200 }, () => {}, { binary, config }),
      /timed out/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
