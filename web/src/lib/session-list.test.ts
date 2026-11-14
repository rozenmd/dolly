import { describe, expect, it } from "vite-plus/test";
import { readSessions } from "./api";
import { sessionList } from "./session-list";

describe("session list", () => {
  const now = 30 * 24 * 60 * 60 * 1000;

  const rows = Array.from({ length: 8 }, (_, index) => ({
    id: String(index),
    updatedAt: index,
  }));

  it("sorts by activity and keeps the five newest even if all are old", () => {
    const lists = sessionList(rows, "", now);
    expect(lists.recent.map((row) => row.id)).toEqual(["7", "6", "5", "4", "3"]);
    expect(lists.older).toBe(3);
    expect(rows[0]?.id).toBe("0");
  });

  it("keeps selected, running, and recently active sessions visible", () => {
    const lists = sessionList(
      [...rows, { id: "running", updatedAt: 0, running: true }, { id: "new", updatedAt: now }],
      "0",
      now,
    );

    expect(lists.recent.map((row) => row.id)).toEqual(["new", "7", "6", "5", "4", "0", "running"]);
  });

  it("separates archived sessions without counting them as recent or older", () => {
    const lists = sessionList(
      [...rows, { id: "archived", updatedAt: now, archived: true }],
      "archived",
      now,
    );

    expect(lists.archived.map((row) => row.id)).toEqual(["archived"]);
    expect(lists.active).toHaveLength(8);
    expect(lists.recent).toHaveLength(5);
    expect(lists.older).toBe(3);
  });

  it("preserves archive state in browser storage and accepts existing saved sessions", () => {
    const session = { id: "one", title: "Task", model: "gpt-6-sol", repository: "", updatedAt: 1 };
    expect(readSessions(JSON.stringify([session]))).toEqual([session]);
    expect(readSessions(JSON.stringify([{ ...session, archived: true }]))[0]?.archived).toBe(true);
    expect(readSessions(JSON.stringify([{ ...session, archived: false }]))[0]?.archived).toBe(
      false,
    );
  });
});
