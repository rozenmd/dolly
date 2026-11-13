import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { readSessions, Snapshot, turnsFromSnapshot, sessionBody } from "./api";

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

  it("preserves repo-less context and can initialize before the first poll", () => {
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
