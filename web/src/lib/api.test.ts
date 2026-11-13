import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { messagesFromSnapshot, readSessions, Snapshot } from "./api";

describe("session transcript", () => {
  it("renders Pi entry model messages, including block content and tool results", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [
        { id: "1", kind: "pi.input", model: [{ role: "user", content: "Run tests" }] },
        {
          id: "2",
          kind: "pi.message",
          model: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Private reasoning" },
                { type: "text", text: "Checking now." },
              ],
            },
          ],
        },
        {
          id: "3",
          kind: "pi.tool",
          model: [
            {
              role: "toolResult",
              toolName: "shell",
              content: [{ type: "text", text: "3 tests passed" }],
            },
          ],
        },
        { id: "4", kind: "bookkeeping" },
      ],
      docs: {},
    });

    expect(messagesFromSnapshot(snapshot)).toEqual([
      { id: "1-0", role: "user", text: "Run tests", toolName: undefined },
      { id: "2-0", role: "assistant", text: "Checking now.", toolName: undefined },
      { id: "3-0", role: "toolResult", text: "3 tests passed", toolName: "shell" },
    ]);
  });

  it("rejects malformed API snapshots instead of assuming their shape", () => {
    expect(() =>
      Schema.decodeUnknownSync(Snapshot)({ entries: [{ model: "bad" }], docs: {} }),
    ).toThrow();
  });

  it("includes live partials and running tool output without duplicating completed tools", () => {
    const snapshot = Schema.decodeUnknownSync(Snapshot)({
      entries: [],
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

    expect(messagesFromSnapshot(snapshot)).toEqual([
      { id: "live-partial", role: "assistant", text: "Working on the fix." },
      { id: "live-tool-1", role: "toolResult", toolName: "shell · running", text: "Running tests" },
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
