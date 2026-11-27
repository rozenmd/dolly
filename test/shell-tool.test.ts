import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Live, Snapshot } from "../src/transcript";
import { headers, signIn } from "./session";

/**
 * The shell tool runs through Pi, the Agent Durable Object and the Sandbox Durable Object's RPC
 * surface, including the live output callback and cancellation. Only the container process is
 * simulated; test/container/sandbox.test.ts runs real commands.
 */

type Script = (
  write: (text: string, stream?: "stdout" | "stderr") => void,
  stopped: Promise<number>,
) => Promise<number>;

/** A stream the test writes to through its controller. */
function writableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
  });

  return { stream, controller };
}

/** A container whose commands are scripts: each gets a writer for stdout and stderr and a promise of the signal that stops it. */
function fakeContainer(scripts: Record<string, Script>) {
  const kills: { command: string; signal: number }[] = [];

  return {
    kills,
    running: true,
    exec: async (argv: string[]) => {
      const command = argv[2]!;
      const script = scripts[command];

      if (!script) throw new Error(`Unexpected command: ${command}`);

      const streams = { stdout: writableStream(), stderr: writableStream() };

      const stop = Promise.withResolvers<number>();

      const exitCode = script(
        (text, stream = "stdout") =>
          streams[stream].controller.enqueue(new TextEncoder().encode(text)),
        stop.promise,
      ).then((code) => {
        // The reader may already have been cancelled, as a stopped command's is.
        for (const { controller } of Object.values(streams))
          try {
            controller.close();
          } catch {}

        return code;
      });

      return {
        stdout: streams.stdout.stream,
        stderr: streams.stderr.stream,
        exitCode,
        kill: (signal: number) => {
          kills.push({ command, signal });
          stop.resolve(signal);
        },
      };
    },
  };
}

function codexEvents(index: number, calls: readonly { arguments: object }[]) {
  const call = calls[index];

  const item = call
    ? {
        type: "function_call",
        id: `fc_${index}`,
        call_id: `call_${index}`,
        name: "shell",
        arguments: JSON.stringify(call.arguments),
      }
    : {
        type: "message",
        id: "msg_shell",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Commands finished", annotations: [] }],
      };

  const events = [
    {
      type: "response.created",
      response: { id: `resp_${index}`, status: "in_progress", output: [] },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const post = (path: string, body: Readonly<Record<string, string>> = {}) =>
  SELF.fetch(`https://worker${path}`, { method: "POST", headers, body: JSON.stringify(body) });

async function session(id: string) {
  const raw = await (await SELF.fetch(`https://worker/api/sessions/${id}`, { headers })).text();

  return Schema.decodeUnknownSync(Snapshot)(JSON.parse(raw));
}

const liveTools = async (id: string) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Live)((await session(id)).docs["pi.live"]))
    ?.tools ?? [];

async function toolResults(id: string) {
  return (await session(id)).entries
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult")
    .map((message) => ({
      isError: message.isError,
      text: Schema.is(Schema.String)(message.content)
        ? message.content
        : message.content.map((block) => block.text).join(""),
    }));
}

/** Start a session whose model makes `calls` to shell, on a sandbox running `scripts`. */
async function start(calls: readonly { arguments: object }[], scripts: Record<string, Script>) {
  const created = await (await post("/api/sessions")).json<{ id: string }>();

  const conversation = await runInDurableObject(env.AGENT.getByName("owner"), (_, state) =>
    state.storage.get(`session:${created.id}`),
  );

  const container = fakeContainer(scripts);
  await runInDurableObject(env.SANDBOX.getByName(String(conversation)), async (instance) => {
    Object.assign(instance, { container: () => Effect.succeed(container) });
  });

  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toContain("api.openai.com");

    return codexEvents(requests++, calls);
  });

  expect(
    (
      await post(`/api/sessions/${created.id}/messages`, {
        content: "Run the commands",
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(202);

  return { id: created.id, container };
}

beforeEach(async () => {
  await reset();
  await signIn();
  const access = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" }, exp: 9_999_999_999 }))}.signature`;
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("credential:openai", {
      type: "oauth",
      access,
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    });
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it(
  "streams a running command's output live and returns the tail of a long one",
  { timeout: 45_000 },
  async () => {
    const release = Promise.withResolvers<void>();
    const linked = Promise.withResolvers<void>();

    const { id } = await start([{ arguments: { command: "build" } }], {
      build: async (write) => {
        write("compiling\n");
        await release.promise;
        // More than Pi keeps of a tool's output, then a new line while still running.
        write(`${"x".repeat(99)}\n`.repeat(600));
        write("linking\n");
        await linked.promise;
        write("build finished\n");

        return 0;
      },
    });

    const live = async () =>
      (await liveTools(id)).find((tool) => tool.name === "shell")?.output ?? "";

    // The first line shows while the command is still running.
    await expect.poll(live, { timeout: 15_000 }).toContain("compiling");
    release.resolve();
    // So does the newest line once the output outgrows what Pi keeps.
    await expect.poll(live, { timeout: 15_000 }).toContain("linking");
    linked.resolve();

    await expect.poll(async () => (await toolResults(id)).length, { timeout: 15_000 }).toBe(1);

    const [result] = await toolResults(id);
    const output = JSON.parse(result!.text);

    expect(result!.isError).toBe(false);
    expect(output.exitCode).toBe(0);
    // The end of the output is kept: that is where summaries and errors are.
    expect(output.stdout).toMatch(/^\[\d+ earlier bytes omitted\]\n/);
    expect(output.stdout).toMatch(/build finished\n$/);
    expect(output.stdout.length).toBeLessThan(33_000);
  },
);

it(
  "stops a command at the model's timeout and returns its output so far",
  { timeout: 45_000 },
  async () => {
    const { id, container } = await start([{ arguments: { command: "hang", timeout: 1 } }], {
      hang: async (write, stopped) => {
        // Both streams' tails, JSON-escaped, are far beyond Pi's 50 KiB result limit.
        write(`${'"'.repeat(40_000)}\nwaiting forever\n`);
        write(`${"\\".repeat(40_000)}\nstill waiting\n`, "stderr");

        return 128 + (await stopped);
      },
    });

    await expect.poll(async () => (await toolResults(id)).length, { timeout: 15_000 }).toBe(1);

    const [result] = await toolResults(id);

    // The result fits whole, so it still parses and keeps the timeout and both streams' ends.
    expect(new TextEncoder().encode(result!.text).length).toBeLessThanOrEqual(48 * 1024);
    expect(JSON.parse(result!.text)).toMatchObject({
      stdout: expect.stringMatching(/^\[\d+ earlier bytes omitted\]\n"+\nwaiting forever\n$/),
      stderr: expect.stringMatching(/^\[\d+ earlier bytes omitted\]\n\\+\nstill waiting\n$/),
      exitCode: 124,
      timedOut: true,
    });
    expect(container.kills).toEqual([{ command: "hang", signal: 15 }]);
  },
);

it(
  "runs a complete command whose call carries a stray extra field",
  { timeout: 45_000 },
  async () => {
    // Argument shapes GPT sent that failed validation with "unknown field" (papercuts log).
    const calls = [
      { command: "one", x: 0 },
      { command: "two", "}": "x" },
      { command: "three", command_unused: "" },
      { command: "four", limit: null, timeout: 30 },
      { command: "five", "}},{": "} }]}  \n", parameters: { command: "five" } },
    ].map((args) => ({ arguments: args }));

    const ran: string[] = [];

    const script = (name: string) => async (write: (text: string) => void) => {
      ran.push(name);
      write(`${name} ran\n`);

      return 0;
    };

    const { id } = await start(
      calls,
      Object.fromEntries(
        ["one", "two", "three", "four", "five"].map((name) => [name, script(name)]),
      ),
    );

    await expect
      .poll(async () => (await toolResults(id)).length, { timeout: 30_000 })
      .toBe(calls.length);

    const results = await toolResults(id);

    expect(results.map((result) => result.isError)).toEqual(calls.map(() => false));
    expect(results.map((result) => JSON.parse(result.text).stdout)).toEqual(
      ["one", "two", "three", "four", "five"].map((name) => `${name} ran\n`),
    );
    expect(ran).toEqual(["one", "two", "three", "four", "five"]);
  },
);

it(
  "rejects a timeout in milliseconds with the allowed range, without running the command",
  { timeout: 45_000 },
  async () => {
    const ran: string[] = [];

    const { id } = await start([{ arguments: { command: "slow", timeout: 60_000 } }], {
      slow: async () => {
        ran.push("slow");

        return 0;
      },
    });

    await expect.poll(async () => (await toolResults(id)).length, { timeout: 15_000 }).toBe(1);

    const [result] = await toolResults(id);

    expect(result!.isError).toBe(true);
    expect(result!.text).toContain("timeout");
    expect(result!.text).toContain("3600");
    expect(ran).toEqual([]);
  },
);

it("kills the command when the session is stopped", { timeout: 45_000 }, async () => {
  const { id, container } = await start([{ arguments: { command: "serve" } }], {
    serve: async (write, stopped) => {
      write("listening\n");

      return 128 + (await stopped);
    },
  });

  await expect
    .poll(async () => (await liveTools(id)).find((tool) => tool.name === "shell")?.output ?? "", {
      timeout: 15_000,
    })
    .toContain("listening");

  expect((await post(`/api/sessions/${id}/abort`)).status).toBe(200);
  await expect
    .poll(() => container.kills, { timeout: 10_000 })
    .toEqual([{ command: "serve", signal: 15 }]);
});

it("stops a run whose cancel reached the Sandbox first", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  const container = fakeContainer({ never: async (_, stopped) => 128 + (await stopped) });

  await runInDurableObject(sandbox, async (instance) => {
    Object.assign(instance, { container: () => Effect.succeed(container) });
  });

  expect(await sandbox.cancel("early")).toBe(false);
  let failure: unknown;

  // Awaiting the RPC directly, as expect().rejects does not, keeps its rejection handled.
  try {
    await sandbox.run("never", {}, { executionId: "early" });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({ message: "The command was cancelled" });
  // It never started, so there was nothing to kill.
  expect(container.kills).toEqual([]);
});
