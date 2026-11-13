import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import type { Live } from "../../../src/transcript";
import { readSessions, Snapshot, turnsFromSnapshot, sessionBody, queueFromSnapshot } from "./api";

describe("queued messages", () => {
  it("reads durable inputs in order, including steering state, but not queued writes", () => {
    expect(
      queueFromSnapshot({
        entries: [],
        docs: {
          "pi.inbox": {
            items: [
              { id: 2, mode: "followUp", content: "Next task" },
              { id: 3, mode: "write", entry: { kind: "note" } },
              { id: 4, mode: "steer", content: [{ type: "text", text: "Correction" }] },
            ],
          },
        },
      }),
    ).toEqual([
      { id: 2, text: "Next task", steering: false },
      { id: 4, text: "Correction", steering: true },
    ]);
  });

  it("handles absent inboxes and removes consumed inputs on the next snapshot", () => {
    expect(queueFromSnapshot({ entries: [], docs: {} })).toEqual([]);
    expect(queueFromSnapshot({ entries: [], docs: { "pi.inbox": { items: [] } } })).toEqual([]);
  });
});

describe("new session context", () => {
  const source = {
    id: "session",
    model: "gpt-6-sol",
    title: "Task",
    repository: "org/primary",
    updatedAt: 1,
  };

  it("inherits the primary repo and policy, never the active attachment", () => {
    expect(
      sessionBody(source, {
        entries: [],
        docs: {
          "app.workspace": {
            config: {
              repository: "org/primary",
              ref: "develop",
              networkHosts: ["registry.npmjs.org"],
              branch: "dolly/old",
            },
            activeRepository: "org/secondary",
          },
        },
      }),
    ).toEqual({
      model: source.model,
      workspace: {
        repository: "org/primary",
        ref: "develop",
        networkHosts: ["registry.npmjs.org"],
      },
    });
  });

  it("preserves repo-less context and can initialize before the first snapshot", () => {
    expect(
      sessionBody(source, { entries: [], docs: { "app.workspace": { config: null } } }),
    ).toEqual({ model: source.model });
    expect(sessionBody(source, null)).toEqual({
      model: source.model,
      workspace: { repository: source.repository },
    });
    expect(sessionBody({ ...source, model: "Existing session", repository: "" }, null)).toEqual({});
  });
});

describe("session transcript", () => {
  it("reports live activity without exposing reasoning, including sequential queued tools", () => {
    const entries = [{ id: 1, kind: "pi.user", model: [{ role: "user", content: "Run tests" }] }];

    const snapshot = (live: typeof Live.Type) =>
      Schema.decodeUnknownSync(Snapshot)({ entries, docs: { "pi.live": live } });

    const [thinking] = turnsFromSnapshot(
      snapshot({
        run: {},
        generation: {
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Private reasoning" }],
          },
        },
      }),
    );

    expect(thinking?.activity).toBe("Thinking");
    expect(thinking?.items).toEqual([]);

    const [responding] = turnsFromSnapshot(
      snapshot({
        run: {},
        generation: { message: { role: "assistant", content: "Checking tests." } },
      }),
    );

    expect(responding?.activity).toBe("Responding");
    expect(responding?.items[0]).toMatchObject({ text: "Checking tests." });

    const [tools] = turnsFromSnapshot(
      snapshot({
        run: {},
        tools: [
          { callId: "1", name: "shell", status: "running", output: "Testing" },
          { callId: "2", name: "workspace", status: "pending" },
        ],
      }),
    );

    expect(tools?.activity).toBe("Running shell");
    expect(tools?.items[0]).toMatchObject({
      steps: [{ status: "running", output: "Testing" }, { status: "pending" }],
    });
    expect(turnsFromSnapshot(snapshot({}))[0]?.activity).toBeUndefined();
  });

  it("shows provider failures with empty assistant content instead of silently dropping them", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [
        { id: 22, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
        {
          id: 25,
          kind: "pi.system",
          model: [{ role: "system", content: "Internal instructions that must not render" }],
        },
        {
          id: 27,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Model unavailable",
            },
          ],
        },
      ],
      docs: {
        "pi.live": {
          runFailure: {
            taskId: 26,
            inputs: [21],
            first: 22,
            reason: "model_error",
            detail: "Model unavailable",
          },
        },
      },
    });

    const [turn] = turnsFromSnapshot(snapshot);
    expect(turn?.prompt?.text).toBe("hi");
    expect(turn?.failure).toMatchObject({ reason: "model_error", detail: "Model unavailable" });
    expect(turn?.running).toBe(false);
    expect(turn?.answer).toBeUndefined();
    expect(turn?.items).toEqual([]);
  });

  it("shows run failures even without an assistant entry or a failure detail", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [],
      docs: { "pi.live": { runFailure: { reason: "no_model" } } },
    });

    expect(turnsFromSnapshot(snapshot)[0]?.failure?.reason).toBe("no_model");
  });

  it("clears transient provider errors after recovery and exposes retry backoff while running", () => {
    const entries = [
      { id: 1, kind: "pi.user", model: [{ role: "user", content: "hi" }] },
      {
        id: 2,
        kind: "pi.assistant",
        model: [
          { role: "assistant", content: [], stopReason: "error", errorMessage: "Rate limited" },
        ],
      },
    ];

    const retry = { at: 5_000, error: "Rate limited" };

    const pending = Schema.decodeUnknownSync(Snapshot)({
      entries,
      docs: { "pi.live": { run: {}, generation: { retry } } },
    });

    const [running] = turnsFromSnapshot(pending);
    expect(running?.retry).toEqual(retry);
    expect(running?.running).toBe(true);
    expect(running?.failure).toBeUndefined();

    const recovered = Schema.decodeUnknownSync(Snapshot)({
      entries: [
        ...entries,
        {
          id: 3,
          kind: "pi.assistant",
          model: [
            { role: "assistant", content: [{ type: "text", text: "Hello!" }], stopReason: "stop" },
          ],
        },
      ],
      docs: { "pi.live": {} },
    });

    const [completed] = turnsFromSnapshot(recovered);
    expect(completed?.answer?.text).toBe("Hello!");
    expect(completed?.failure).toBeUndefined();
  });

  it("attaches a retained failure to its original prompt rather than a newer queued message", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [
        { id: 1, kind: "pi.user", model: [{ role: "user", content: "First task" }] },
        { id: 2, kind: "pi.user", model: [{ role: "user", content: "Next task" }] },
      ],
      docs: {
        "pi.live": {
          run: {},
          runFailure: { first: 1, reason: "model_error", detail: "Failed first task" },
        },
      },
    });

    const turns = turnsFromSnapshot(snapshot);
    expect(turns[0]?.failure?.detail).toBe("Failed first task");
    expect(turns[1]?.failure).toBeUndefined();
    expect(turns[1]?.running).toBe(true);
  });

  it("groups each prompt with its tool steps and final answer", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [
        {
          id: 1,
          kind: "pi.input",
          model: [{ role: "user", content: "Run tests", timestamp: 1_000 }],
        },
        {
          id: 2,
          kind: "pi.message",
          model: [
            {
              role: "assistant",
              timestamp: 2_000,
              content: [
                { type: "thinking", thinking: "Private reasoning" },
                { type: "text", text: "Checking now." },
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "bash",
                  arguments: { command: "pnpm test" },
                },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "bash",
              timestamp: 3_000,
              content: [{ type: "text", text: "3 tests passed" }],
            },
            {
              role: "assistant",
              timestamp: 61_000,
              content: [{ type: "text", text: "All green." }],
            },
          ],
        },
        { id: 3, kind: "bookkeeping" },
      ],
      before: 0,
      docs: {},
    });

    expect(turnsFromSnapshot(snapshot)).toEqual([
      {
        id: "1-0",
        prompt: { text: "Run tests", at: 1_000 },
        items: [
          { kind: "text", id: "2-0-1", text: "Checking now." },
          {
            kind: "steps",
            id: "2-0-2",
            steps: [
              {
                id: "call-1",
                name: "bash",
                detail: "pnpm test",
                output: "3 tests passed",
                status: "done",
              },
            ],
          },
        ],
        answer: { id: "2-2-0", text: "All green." },
        steps: 1,
        startedAt: 2_000,
        endedAt: 61_000,
        running: false,
      },
    ]);
  });

  it("counts referenced screenshots without exposing their storage references as prompt text", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [
        {
          id: 1,
          kind: "pi.user",
          model: [
            {
              role: "user",
              timestamp: 1000,
              content: [
                { type: "text", text: "Review this" },
                { type: "image", mimeType: "image/png", data: "r2://screenshots/png/one" },
                { type: "image", mimeType: "image/jpeg", data: "r2://screenshots/jpeg/two" },
              ],
            },
          ],
        },
      ],
      docs: {},
    });

    expect(turnsFromSnapshot(snapshot)[0]?.prompt).toEqual({
      text: "Review this",
      at: 1000,
      images: 2,
    });
  });

  it("rejects malformed API snapshots instead of assuming their shape", () => {
    expect(() =>
      Schema.decodeUnknownSync(Snapshot)({ entries: [{ model: "bad" }], docs: {} }),
    ).toThrow();
  });

  it("keeps a running turn open with live text and running tools, skipping finished tools", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [{ id: 1, kind: "pi.input", model: [{ role: "user", content: "Fix it" }] }],
      docs: {
        "pi.live": {
          run: {},
          generation: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Working on the fix." }],
            },
          },
          tools: [
            { callId: "1", name: "shell", status: "running", output: "Running tests" },
            { callId: "2", name: "workspace", status: "done", output: "Already in transcript" },
          ],
        },
      },
    });

    const [turn] = turnsFromSnapshot(snapshot);

    expect(turn?.running).toBe(true);
    expect(turn?.answer).toBeUndefined();
    expect(turn?.items).toEqual([
      { kind: "text", id: "live-0", text: "Working on the fix." },
      {
        kind: "steps",
        id: "live-1",
        steps: [{ id: "1", name: "shell", detail: "", output: "Running tests", status: "running" }],
      },
    ]);
  });
});

describe("browser session index", () => {
  it("recovers from invalid JSON and old or malformed records", () => {
    expect(readSessions("not json")).toEqual([]);
    expect(readSessions('[{"id":"missing-fields"}]')).toEqual([]);
  });

  it("keeps metadata and strips unrecognized fields", () => {
    expect(
      readSessions(
        JSON.stringify([
          {
            id: "session-1",
            model: "gpt-6-sol",
            title: "Fix tests",
            repository: "owner/repo",
            updatedAt: 1,
            token: "never-store-this",
          },
        ]),
      ),
    ).toEqual([
      {
        id: "session-1",
        model: "gpt-6-sol",
        title: "Fix tests",
        repository: "owner/repo",
        updatedAt: 1,
      },
    ]);
  });
});
