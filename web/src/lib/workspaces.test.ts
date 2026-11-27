import { describe, expect, it } from "vite-plus/test";
import { rootSession, sidebarSessions } from "./session-threads";
import { workspaceOf, workspaceRows, workspaceTabs } from "./workspaces";

const session = (id: string, fields: Record<string, string | number | boolean> = {}) => ({
  id,
  title: id,
  repository: "octocat/project",
  updatedAt: 1,
  ...fields,
});

describe("workspaces", () => {
  const sessions = [
    session("chief", { chief: true, title: "Barbie", repository: "", workspaceId: "w-chief" }),
    // The server names the workspace it starts; an older one said the chief's.
    session("delegated", { parentId: "chief", workspaceId: "w-delegated", running: true }),
    session("legacy", { parentId: "chief", workspaceId: "w-chief", updatedAt: 2 }),
    session("helper", { parentId: "delegated", workspaceId: "w-delegated" }),
    session("work", { workspaceId: "w-work" }),
    session("child", { parentId: "work", workspaceId: "w-work" }),
    session("review", { parentId: "chief", automation: "review", workspaceId: "w-review" }),
  ];

  it("gives each session the chief spawns a workspace of its own", () => {
    expect(workspaceOf(sessions, "delegated")).toBe("w-delegated");
    expect(workspaceOf(sessions, "legacy")).toBe("legacy");
    // Its own children, and other sessions' children, still join their root's.
    expect(workspaceOf(sessions, "helper")).toBe("w-delegated");
    expect(workspaceOf(sessions, "child")).toBe("w-work");
    expect(rootSession(sessions, "helper")).toBe("delegated");
    expect(rootSession(sessions, "child")).toBe("work");
  });

  it("lists them as sidebar rows marked with the chief's name", () => {
    const rows = workspaceRows(sessions);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect([...byId.keys()].sort()).toEqual(
      ["legacy", "w-chief", "w-delegated", "w-review", "w-work"].sort(),
    );
    expect(byId.get("w-delegated")).toMatchObject({
      main: "delegated",
      from: "Barbie",
      running: true,
    });
    expect(byId.get("w-work")).not.toHaveProperty("from");
    expect(byId.get("w-chief")?.sessions.map((tab) => tab.id)).toEqual(["chief"]);
    expect(workspaceTabs(sessions, "w-delegated").map((tab) => tab.id)).toEqual(["delegated"]);
    expect(workspaceTabs(sessions, "w-work").map((tab) => tab.id)).toEqual(["work"]);
  });

  it("falls back to them like any other sidebar session, but not to reviews", () => {
    expect(
      sidebarSessions(sessions)
        .map((item) => item.id)
        .sort(),
    ).toEqual(["chief", "delegated", "legacy", "work"]);
  });
});
