import { expect, it } from "vitest";
import {
  GITHUB_APP_GRANT_PERMISSIONS,
  GITHUB_APP_READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS,
  GITHUB_APP_CODE_PERMISSIONS,
} from "../src/github-permissions";
import { checkedPush, gitRoute } from "../src/git-transport";
import { checkoutScript, shellQuote, workspaceConfig } from "../src/workspace";

function packet(command: string) {
  return (new TextEncoder().encode(command).length + 4).toString(16).padStart(4, "0") + command;
}

const branch = "pi-hard/session-42";

const update = (ref: string, next = "b".repeat(40)) =>
  packet(`${"a".repeat(40)} ${next} ${ref}\0report-status side-band-64k\n`);

it("permits only the selected repository's Git smart HTTP routes", () => {
  for (const path of [
    "/org/project.git/info/refs?service=git-upload-pack",
    "/org/project.git/info/refs?service=git-receive-pack",
  ])
    expect(gitRoute(new Request(`http://github.workspace${path}`), "org/project")).not.toBeNull();

  for (const path of [
    "/org/other.git/info/refs?service=git-upload-pack",
    "/org/project.git/info/refs?service=other",
    "/org/project.git/info/refs?service=git-upload-pack&extra=1",
    "/org/project.git/config",
    "/api/repos",
    "/org/project.git/../other.git/git-upload-pack",
  ])
    expect(gitRoute(new Request(`http://github.workspace${path}`), "org/project")).toBeNull();
  expect(
    gitRoute(
      new Request("https://github.workspace/org/project.git/git-upload-pack", { method: "POST" }),
      "org/project",
    ),
  ).toBeNull();
});

it("streams an accepted push unchanged across fragmented packets", async () => {
  const text = update(`refs/heads/${branch}`) + "0000PACKbinary-payload";
  const bytes = new TextEncoder().encode(text);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 3)
        controller.enqueue(bytes.slice(index, index + 3));
      controller.close();
    },
  });

  const checked = await checkedPush(stream, branch);
  expect(checked).not.toBeNull();
  expect(await new Response(checked).text()).toBe(text);
});

it("refuses other branches, tags, deletes, multiple ref updates and malformed pushes, cancelling rejected bodies", async () => {
  for (const text of [
    update("refs/heads/main") + "0000PACK",
    update("refs/tags/v1") + "0000PACK",
    update(`refs/heads/${branch}`, "0".repeat(40)) + "0000PACK",
    update(`refs/heads/${branch}`) + update("refs/heads/main") + "0000PACK",
    "0000",
    "zzzz",
    "0004",
    update(`refs/heads/${branch}`),
  ]) {
    let cancelled = false;
    let emitted = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          emitted = true;
          controller.enqueue(new TextEncoder().encode(text));
        } else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    expect(await checkedPush(stream, branch)).toBeNull();
    expect(cancelled || !stream.locked).toBe(true);
    expect(stream.locked).toBe(false);
  }
});

it("quotes shell values and keeps checkout refs out of shell syntax", () => {
  expect(shellQuote("a'b")).toBe("'a'\\''b'");

  const config = workspaceConfig(
    { repository: "different-owner/project", ref: "main'; touch /tmp/injected; '" },
    "42",
  );

  expect(checkoutScript(config)).toContain("ref='main'\\''; touch /tmp/injected; '\\'''\n");
  expect(config.networkHosts).toEqual([]);
});

it("keeps Open Session's public permission maps and narrows every mint to the App grant", () => {
  expect(GITHUB_APP_GRANT_PERMISSIONS).toEqual({
    actions: "write",
    checks: "write",
    statuses: "read",
    contents: "write",
    pull_requests: "write",
    issues: "write",
    members: "read",
    deployments: "write",
    metadata: "read",
  });

  for (const permissions of [
    GITHUB_APP_READ_PERMISSIONS,
    GITHUB_APP_WRITE_PERMISSIONS,
    GITHUB_APP_CODE_PERMISSIONS,
  ])
    for (const [name, permission] of Object.entries(permissions)) {
      const grant = Object.entries(GITHUB_APP_GRANT_PERMISSIONS).find(([key]) => key === name)?.[1];
      expect(grant).toBeDefined();
      expect(permission === "read" || grant === "write").toBe(true);
    }
});
