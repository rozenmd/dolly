import { env, exports as entrypoints } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Files } from "@cloudflare/sandbox";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Env as WorkerEnv } from "../../src/env";
import { workspaceConfig } from "../../src/workspace";
import type { PreviewOutbound } from "../../src/preview";
import type { SandboxOutbound } from "../../src/browser-workspace";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

const TimingLog = Schema.Struct({
  event: Schema.String,
  phase: Schema.String,
  initializationId: Schema.String,
  operation: Schema.optional(Schema.String),
  executionId: Schema.optional(Schema.String),
  elapsedMs: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
});

it("times real initialization steps, process launch and live-container reconnection", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  const config = workspaceConfig({ repository: "fixture/timings" }, "timings");

  try {
    await runInDurableObject(sandbox, async (instance, state) => {
      await state.storage.put("workspace", config);
      const logs: (typeof TimingLog.Type)[] = [];

      let duringStartup:
        | Promise<Awaited<ReturnType<typeof instance.diagnostics>>["initialization"]>
        | undefined;

      const logger = Logger.make((options) => {
        const parsed = Schema.decodeUnknownOption(Schema.Array(TimingLog))(options.message);

        if (Option.isSome(parsed)) {
          logs.push(...parsed.value);

          if (parsed.value.some((log) => log.operation === "total" && log.phase === "started"))
            duringStartup = instance
              .diagnostics()
              .then((diagnostics) => structuredClone(diagnostics.initialization));
        }
      });

      const result = await Effect.runPromise(
        instance["execute"]("printf timing-proof", "/workspace").pipe(
          Effect.provide(Logger.layer([logger])),
        ),
      );

      expect(result).toMatchObject({ exitCode: 0, stdout: "timing-proof" });
      expect(await duringStartup).toMatchObject({ state: "running" });
      const diagnostics = await instance.diagnostics();
      const initialization = diagnostics.initialization;

      expect(initialization).toMatchObject({
        id: expect.any(String),
        wasRunning: false,
        restoringSnapshot: false,
        state: "succeeded",
        elapsedMs: expect.any(Number),
      });

      if (!initialization) throw new Error("Missing initialization timings");

      expect(initialization.steps.map((step) => step.operation)).toEqual([
        "workspace.read",
        "workspace.snapshot.read",
        "workspace.dependencies.cleanup",
        "workspace.start",
        "workspace.restore.record",
        "workspace.network.http",
        "workspace.network.https",
        "sandbox.inactivity",
      ]);

      for (const step of initialization.steps) {
        expect(step.state).toBe("succeeded");
        expect(step.startedAt).toBeGreaterThanOrEqual(initialization.startedAt);
        expect(step.elapsedMs).toBeGreaterThanOrEqual(0);
        const events = logs.filter((log) => log.operation === step.operation);

        expect(events.map((log) => log.phase)).toEqual(["started", "succeeded"]);
        expect(events[1]?.elapsedMs).toBe(step.elapsedMs);
      }

      expect(initialization.elapsedMs).toBeGreaterThanOrEqual(
        initialization.steps.reduce((total, step) => total + (step.elapsedMs ?? 0), 0),
      );
      const execution = logs.filter((log) => log.event === "sandbox_execution");

      expect(execution.map((log) => log.phase)).toEqual([
        "started",
        "process_started",
        "completed",
      ]);
      expect(new Set(logs.map((log) => log.initializationId))).toEqual(
        new Set([initialization.id]),
      );
      expect(new Set(execution.map((log) => log.executionId)).size).toBe(1);
      expect(execution[1]?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(execution[2]?.elapsedMs).toBeGreaterThanOrEqual(execution[1]?.elapsedMs ?? 0);
      expect(execution[2]?.exitCode).toBe(0);
      const beforeWarm = structuredClone(initialization);

      // Warm commands must not replace or append to the last startup report.
      await Effect.runPromise(instance["execute"]("true", "/workspace"));
      expect((await instance.diagnostics()).initialization).toEqual(beforeWarm);

      let timedOut = false;

      try {
        await Effect.runPromise(
          instance["execute"]("sleep 120", "/workspace", 0.1).pipe(
            Effect.provide(Logger.layer([logger])),
          ),
        );
      } catch (error) {
        expect(error).toHaveProperty("_tag", "TimeoutError");
        timedOut = true;
      }

      expect(timedOut).toBe(true);
      expect(logs.at(-1)).toMatchObject({
        event: "sandbox_execution",
        phase: "failed",
        elapsedMs: expect.any(Number),
      });
      expect(logs.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(100);
    });

    await evictDurableObject(sandbox);
    await runInDurableObject(sandbox, async (instance) => {
      await Effect.runPromise(instance["execute"]("true", "/workspace"));
      const initialization = (await instance.diagnostics()).initialization;

      expect(initialization).toMatchObject({ wasRunning: true, state: "succeeded" });
      expect(initialization?.steps.map((step) => step.operation)).toEqual([
        "workspace.read",
        "workspace.snapshot.read",
        "workspace.network.http",
        "workspace.network.https",
        "workspace.setup.read",
        "workspace.restore.probe",
        "sandbox.inactivity",
      ]);
    });
  } finally {
    await sandbox.restart();
  }
});

it("privately previews without an image-provided runtime directory and preserves workspace files", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    await sandbox.run("printf preserved > /workspace/preview-proof.txt");
    // Older/restored containers need not have the current image's runtime directory.
    await runInDurableObject(sandbox, async (_, state) => {
      if (!state.container) throw new Error("Missing test container");
      await new Files(state.container).remove("/run/sandbox", {
        recursive: true,
        force: true,
        user: "0:0",
      });
    });
    expect(await sandbox.run("test ! -e /run/sandbox")).toMatchObject({ exitCode: 0 });
    await sandbox.previewStart(
      `node -e 'require("http").createServer((req,res)=>res.end("preview:"+req.url)).listen(3000,"0.0.0.0")'`,
      3000,
    );
    expect(await sandbox.previewStatus()).toMatchObject({ running: true, port: 3000 });
    const { token } = await sandbox.previewCapability();
    expect(
      (await sandbox.previewFetch(new Request("http://private.test/hello"), "wrong")).status,
    ).toBe(404);
    expect(
      await (
        await sandbox.previewFetch(new Request("http://private.test/hello?a=1"), token)
      ).text(),
    ).toBe("preview:/hello?a=1");
    let duplicate: unknown;

    try {
      await sandbox.previewStart("sleep 60", 3001);
    } catch (error) {
      duplicate = error;
    }

    expect(String(duplicate)).toContain("already running");
    await sandbox.previewStop();
    expect((await sandbox.previewFetch(new Request("http://private.test/"), token)).status).toBe(
      404,
    );
    expect(await sandbox.readFile("/workspace/preview-proof.txt")).toBe("preserved");
    // The port is released, so a new preview can reuse it.
    await sandbox.previewStart(
      `node -e 'require("http").createServer((req,res)=>res.end("again")).listen(3000,"0.0.0.0")'`,
      3000,
    );
    expect((await sandbox.previewCapability()).token).not.toBe(token);
    expect((await sandbox.previewFetch(new Request("http://private.test/"), token)).status).toBe(
      404,
    );
  } finally {
    await sandbox.previewStop();
    await sandbox.restart();
  }
});

/** A dependency-free WebSocket server: greets each upgrade with its path and cookie. */
const WEBSOCKET_SERVER = `node -e '
const http = require("http"), crypto = require("crypto");
const server = http.createServer((req, res) => res.end("http:" + req.url));
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  const text = Buffer.from("ws:" + req.url + " cookie:" + (req.headers.cookie || "none"));
  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
});
server.listen(3000, "0.0.0.0");
'`;

async function firstMessage(response: Response) {
  const socket = response.webSocket;

  if (!socket) throw new Error(`Expected a WebSocket, got HTTP ${response.status}`);

  const message = new Promise<string>((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)));
    socket.addEventListener("close", () => reject(new Error("closed before a message")));
  });

  socket.accept();

  try {
    return await message;
  } finally {
    socket.close();
  }
}

it("carries a page's WebSocket upgrades to the dev server with the preview's access checks", async () => {
  const name = crypto.randomUUID();
  const sandbox = env.SANDBOX.getByName(name);

  // SAFETY: src/index.ts exports both outbound entrypoints.
  const loopback = entrypoints as Cloudflare.Exports & {
    PreviewOutbound: LoopbackForExport<typeof PreviewOutbound>;
    SandboxOutbound: LoopbackForExport<typeof SandboxOutbound>;
  };

  const upgrade = (url: string) =>
    new Request(url, { headers: { Upgrade: "websocket", Cookie: "app-session" } });

  try {
    await sandbox.previewStart(WEBSOCKET_SERVER, 3000);
    const { token } = await sandbox.previewCapability();
    const hostname = "preview-websocket.test";

    const outbound = (token: string) =>
      loopback.PreviewOutbound({ props: { sandboxId: name, token, hostname } });

    const live = await outbound(token).fetch(upgrade(`http://${hostname}/api/events?x=1`));
    expect(live.status).toBe(101);
    // A real upgrade reached the server, without the application's cookie.
    expect(await firstMessage(live)).toBe("ws:/api/events?x=1 cookie:none");
    expect(await (await outbound(token).fetch(`http://${hostname}/page`)).text()).toBe(
      "http:/page",
    );
    // The same checks as HTTP: a wrong token or host gets nothing.
    expect((await outbound("forged").fetch(upgrade(`http://${hostname}/ws`))).status).toBe(404);
    expect((await outbound(token).fetch(upgrade("http://other.test/ws"))).status).toBe(404);

    // The brokered browser's sandbox host carries upgrades too.
    const browser = loopback.SandboxOutbound({
      props: { sandbox: sandbox.id.toString(), port: 3000 },
    });

    expect(
      await firstMessage(await browser.fetch(upgrade("http://sandbox.workspace/socket"))),
    ).toBe("ws:/socket cookie:none");

    await sandbox.previewStop();
    expect((await outbound(token).fetch(upgrade(`http://${hostname}/ws`))).status).toBe(404);
  } finally {
    await sandbox.previewStop();
    await sandbox.restart();
  }
});

it("stops failed preview commands and retains bounded failure logs", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    let failure: unknown;

    try {
      // Bash-only syntax: preview commands run in bash, like shell commands.
      await sandbox.previewStart(
        'a=(deliberate preview failure); IFS=-; echo "${a[*]}"; exit 1',
        3000,
      );
    } catch (error) {
      failure = error;
    }

    // The error carries the log tail, so the agent need not call status to see why.
    expect(String(failure)).toContain("Dev server exited before it answered on port 3000");
    expect(String(failure)).toContain("deliberate-preview-failure");
    expect(await sandbox.previewStatus()).toMatchObject({
      running: false,
      logs: expect.stringContaining("deliberate-preview-failure"),
      message: expect.stringContaining("The last preview start on port 3000 failed at"),
    });
  } finally {
    await sandbox.restart();
  }
});

it("leaves a slow dev server starting, and screenshot capability waits for it", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    // Slower than start's 30-second wait, like a large monorepo's first compile.
    const started = await sandbox.previewStart(
      `echo compiling; sleep 40; node -e 'require("http").createServer((req,res)=>res.end("slow")).listen(3000,"0.0.0.0")'`,
      3000,
    );

    expect(started).toMatchObject({
      ready: false,
      state: "starting",
      port: 3000,
      message: expect.stringContaining("left starting"),
      logTail: expect.stringContaining("compiling"),
    });
    expect(await sandbox.previewStatus()).toMatchObject({
      running: true,
      ready: false,
      state: "starting",
    });
    const { token } = await sandbox.previewCapability();
    expect(await sandbox.previewStatus()).toMatchObject({ running: true, ready: true });
    expect(
      await (await sandbox.previewFetch(new Request("http://private.test/"), token)).text(),
    ).toBe("slow");
  } finally {
    await sandbox.previewStop();
    await sandbox.restart();
  }
});

it("enforces preview supervisor TTL and bounds logs independently of the Durable Object", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    const result = await sandbox.run(
      `DOLLY_COMMAND="python3 -c 'import time; print(\\"x\\"*40000, flush=True); time.sleep(60)'" python3 /usr/local/lib/dolly-preview.py 1 /run/sandbox/ttl.log; wc -c < /run/sandbox/ttl.log`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("32768");
  } finally {
    await sandbox.restart();
  }
});

it("executes commands and uses Sandbox 1.0 Files in isolated containers", async () => {
  const first = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await first.run("printf 'sandbox proof' > proof.txt; cat proof.txt")).toMatchObject({
    stdout: "sandbox proof",
    exitCode: 0,
  });
  expect(await first.readFile("/workspace/proof.txt")).toBe("sandbox proof");
  expect(await first.run("exit 7")).toMatchObject({ exitCode: 7 });
  const environment = await first.run("env; id -u");
  expect(environment.stdout).not.toContain("API_TOKEN");
  expect(environment.stdout).not.toContain("OPENAI");
  expect(environment.stdout).toContain("1000");
  expect(await first.run("test -w /run/sandbox && test -x /run/sandbox")).toMatchObject({
    exitCode: 0,
  });
  const second = env.SANDBOX.getByName(crypto.randomUUID());
  expect(await second.run("test ! -e /workspace/proof.txt")).toMatchObject({ exitCode: 0 });
});

it("keeps a live container alive for a running turn without ever starting one", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    expect(await sandbox.keepAlive()).toBe(false);
    expect(await sandbox.diagnostics()).toMatchObject({ running: false });
    expect(await sandbox.run("printf live")).toMatchObject({ stdout: "live", exitCode: 0 });
    expect(await sandbox.keepAlive()).toBe(true);
    // A second call within the interval is a no-op, and the container keeps working.
    expect(await sandbox.keepAlive()).toBe(true);
    expect(await sandbox.run("printf still")).toMatchObject({ stdout: "still", exitCode: 0 });
  } finally {
    await sandbox.restart();
  }
});

it("runs commands with bash, keeps the command out of argv and preserves exits and timeouts", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    expect(
      await sandbox.run(
        [
          "a=(x y z); echo ${#a[@]} ${a[1]}",
          "x=banana; echo ${x//a/o}",
          "false | true; echo ${PIPESTATUS[0]}",
          "echo pre{a,b}post",
        ].join("\n"),
      ),
    ).toMatchObject({ exitCode: 0, stdout: "3 y\nbonono\n1\npreapost prebpost\n", stderr: "" });
    // Exit codes, stderr and the login shell's `exit` stay exactly as before.
    expect(await sandbox.run("printf out; printf err >&2; exit 3")).toMatchObject({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
    });
    expect(await sandbox.run("kill -TERM $$")).toMatchObject({ exitCode: 143 });
    expect(await sandbox.run("pwd")).toMatchObject({ stdout: "/workspace\n" });
    const marker = `dolly-marker-${crypto.randomUUID()}`;
    // The command used to be in the wrapper's argv, so this loop killed the wrapper (exit 143).
    expect(
      await sandbox.run(
        `pgrep -af "${marker}" && exit 9
for p in $(pgrep -f "${marker}"); do kill $p; done
grep -l "[d]${marker.slice(1)}" /proc/[0-9]*/cmdline 2>/dev/null && exit 8
test -z "\${DOLLY_COMMAND+set}" || exit 7
echo survived`,
      ),
    ).toMatchObject({ exitCode: 0, stdout: "survived\n" });
    expect(await sandbox.run("echo early; sleep 120", {}, { timeout: 1 })).toMatchObject({
      exitCode: 124,
      timedOut: true,
      stdout: "early\n",
    });
  } finally {
    await sandbox.restart();
  }
});

it("writes and edits files through Sandbox Files with line diff stats and clear failures", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    expect(await sandbox.writeFile("/workspace/notes/new/todo.md", "one\ntwo\nthree\n")).toEqual({
      change: { path: "/workspace/notes/new/todo.md", created: true, added: 3, removed: 0 },
    });
    expect(await sandbox.run("stat -c %U notes/new/todo.md; cat notes/new/todo.md")).toMatchObject({
      stdout: "node\none\ntwo\nthree\n",
      exitCode: 0,
    });
    expect(
      await sandbox.writeFile("/workspace/notes/new/todo.md", "one\n2\nthree\nfour\n"),
    ).toEqual({
      change: { path: "/workspace/notes/new/todo.md", created: false, added: 2, removed: 1 },
    });
    expect(
      await sandbox.editFile("/workspace/notes/new/todo.md", {
        old_string: "2\nthree\n",
        new_string: "two\n",
      }),
    ).toEqual({
      change: { path: "/workspace/notes/new/todo.md", replacements: 1, added: 1, removed: 2 },
    });
    expect(await sandbox.readFile("/workspace/notes/new/todo.md")).toBe("one\ntwo\nfour\n");

    await sandbox.writeFile("/workspace/repeat.txt", "x = 1\nx = 1\n");
    expect(
      await sandbox.editFile("/workspace/repeat.txt", { old_string: "x = 1", new_string: "x = 2" }),
    ).toEqual({
      refused: expect.stringContaining("old_string matches 2 places in /workspace/repeat.txt"),
    });
    expect(
      await sandbox.editFile("/workspace/repeat.txt", { old_string: "y", new_string: "z" }),
    ).toEqual({
      refused: expect.stringContaining("old_string was not found in /workspace/repeat.txt"),
    });
    expect(
      await sandbox.editFile("/workspace/missing.txt", { old_string: "a", new_string: "b" }),
    ).toEqual({ refused: "/workspace/missing.txt does not exist; use write_file to create it" });
    expect(
      await sandbox.editFile("/workspace/notes", { old_string: "a", new_string: "b" }),
    ).toEqual({
      refused: expect.stringContaining("/workspace/notes is a directory, not a regular file"),
    });
    expect(await sandbox.readFile("/workspace/repeat.txt")).toBe("x = 1\nx = 1\n");
    expect(
      await sandbox.editFile("/workspace/repeat.txt", {
        old_string: "x = 1",
        new_string: "x = 2",
        replace_all: true,
      }),
    ).toEqual({ change: { path: "/workspace/repeat.txt", replacements: 2, added: 2, removed: 2 } });

    expect(await sandbox.run("printf '\\377\\376' > binary.bin")).toMatchObject({ exitCode: 0 });
    expect(
      await sandbox.editFile("/workspace/binary.bin", { old_string: "a", new_string: "b" }),
    ).toEqual({ refused: expect.stringContaining("/workspace/binary.bin is not UTF-8 text") });
  } finally {
    await sandbox.restart();
  }
});

it("keeps repository-less workspaces ephemeral", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    expect(await sandbox.run("printf ephemeral > local.txt")).toMatchObject({ exitCode: 0 });
    expect(await sandbox.readFile("/workspace/local.txt")).toBe("ephemeral");
    await sandbox.restart();
    expect(await sandbox.diagnostics()).toMatchObject({ running: false });
    expect(await sandbox.run("test ! -e local.txt")).toMatchObject({ exitCode: 0 });
  } finally {
    await sandbox.restart();
  }
});

it("fails closed on a missing saved snapshot rather than cloning over lost work", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());
  const config = workspaceConfig({ repository: "owner/project" }, "snapshot-fixture");
  const id = "missing-native-snapshot";
  await runInDurableObject(sandbox, async (_, state) => {
    await state.storage.put("workspace", config);
    await state.storage.put("snapshot:checkpoint", { id });
  });
  let failure: unknown;

  try {
    await sandbox.prepare(config);
  } catch (error) {
    failure = error;
  }

  expect(String(failure)).toContain(id);
  expect(await sandbox.diagnostics()).toMatchObject({ running: false });
  const initialization = (await sandbox.diagnostics()).initialization;

  expect(initialization).toMatchObject({
    state: "failed",
    restoringSnapshot: true,
    elapsedMs: expect.any(Number),
  });
  expect(initialization?.steps).toContainEqual(
    expect.objectContaining({
      operation: "workspace.restore.probe",
      state: "failed",
      elapsedMs: expect.any(Number),
    }),
  );
  await runInDurableObject(sandbox, async (_, state) => {
    expect(await state.storage.get("snapshot:checkpoint")).toEqual({ id });
  });
});

it("timeout kills command descendants, reaps them, and leaves detached services running", async () => {
  const sandbox = env.SANDBOX.getByName(crypto.randomUUID());

  try {
    await runInDurableObject(sandbox, async (instance) => {
      // Exercise the real executor with a short deadline, not a mocked timeout.
      const runtime: object = instance;

      // SAFETY: runInDurableObject supplies Sandbox; execute is TS-private, not a JS #private field.
      const executor = runtime as {
        execute(command: string, cwd: string, timeout: number): Effect.Effect<unknown, unknown>;
      };

      let failure: unknown;

      try {
        await Effect.runPromise(
          executor.execute(
            `setsid sleep 120 >/dev/null 2>&1 </dev/null &
echo $! > detached.pid
python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open("child.pid", "w").write(str(os.getpid())); time.sleep(120)' &
wait`,
            "/workspace",
            2,
          ),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toHaveProperty("_tag", "TimeoutError");
    });
    await expect
      .poll(
        async () =>
          (await sandbox.run('test ! -e /proc/$(cat child.pid) && kill -0 "$(cat detached.pid)"'))
            .exitCode,
        { timeout: 5000 },
      )
      .toBe(0);
  } finally {
    await sandbox.restart();
  }
});
