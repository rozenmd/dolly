import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  GITHUB_APP_GRANT_PERMISSIONS,
  GITHUB_APP_READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS,
  GITHUB_APP_CODE_PERMISSIONS,
} from "../src/github-permissions";
import { checkedPush, gitRoute } from "../src/git-transport";
import {
  activeWorkspace,
  selectRepository,
  checkoutScript,
  checkoutDiagnosticsScript,
  shellQuote,
  workspaceConfig,
  workspacePrompt,
  WorkspaceRequest,
  WorkspaceToolInput,
  type WorkspaceState,
} from "../src/workspace";

it("publishes workspace actions as root object properties while validating action requirements", () => {
  const schema = Schema.toJsonSchemaDocument(WorkspaceToolInput).schema;
  expect(schema).toMatchObject({
    type: "object",
    required: ["action"],
    properties: {
      action: { enum: expect.arrayContaining(["repositories", "checkout", "attach"]) },
      repository: { anyOf: expect.arrayContaining([{ type: "null" }]) },
      ref: { anyOf: expect.arrayContaining([{ type: "null" }]) },
    },
  });
  expect(schema).not.toHaveProperty("anyOf");
  const decode = Schema.decodeUnknownSync(WorkspaceRequest);
  expect(() => decode({ action: "checkout" })).toThrow();
  expect(() => decode({ action: "commit" })).toThrow();
  expect(() => decode({ action: "open_pull_request", title: "Fix" })).toThrow();
  expect(decode({ action: "checkout", repository: "owner/repo" })).toEqual({
    action: "checkout",
    repository: "owner/repo",
  });
});

it("gives the model authoritative primary/active repository context without inventing access", () => {
  const primary = workspaceConfig({ repository: "rozenmd/dolly", ref: "main" }, "42");
  const state: WorkspaceState = { config: primary };
  expect(workspacePrompt(state)).toContain('"primary":"rozenmd/dolly"');
  expect(workspacePrompt(state)).toContain("do not ask them which owner/repository");
  expect(workspacePrompt(state)).toContain("not proof of GitHub access");
  expect(workspacePrompt(state)).toContain("workspace checkout");
  selectRepository(state, { action: "attach", repository: "org/secondary", ref: "develop" }, "42");
  const prompt = workspacePrompt(state);
  expect(prompt).toContain('"primary":"rozenmd/dolly"');
  expect(prompt).toContain('"active":"org/secondary"');
  expect(prompt).toContain('"ref":"develop"');
  expect(prompt).toContain('"branch":"dolly/session-42"');
  expect(prompt).toContain("empty repository discovery");
});

it("describes repo-less sessions without assuming that Dolly means this codebase", () => {
  for (const state of [undefined, { config: null }]) {
    expect(workspacePrompt(state)).toContain('"primary":null');
    expect(workspacePrompt(state)).toContain("no primary repository");
  }
});

it("keeps the primary repo anchored while attaching and switching isolated checkouts", () => {
  const primary = workspaceConfig(
    { repository: "org/primary", ref: "main", networkHosts: ["registry.npmjs.org"] },
    "42",
  );

  const state: WorkspaceState = { config: primary };
  expect(activeWorkspace(state, "42")).toEqual({ config: primary, sandboxId: "42" });
  selectRepository(state, { action: "attach", repository: "org/secondary", ref: "develop" }, "42");
  const secondary = activeWorkspace(state, "42");
  expect(secondary?.sandboxId).toBe("42:repo:org/secondary");
  expect(secondary?.config).toMatchObject({
    repository: "org/secondary",
    ref: "develop",
    branch: primary.branch,
    networkHosts: primary.networkHosts,
  });
  expect(state.config).toBe(primary);
  selectRepository(state, { action: "checkout", repository: "ORG/PRIMARY" }, "42");
  expect(activeWorkspace(state, "42")?.sandboxId).toBe("42");
  selectRepository(state, { action: "attach", repository: "org/secondary" }, "42");
  expect(activeWorkspace(state, "42")).toEqual(secondary);
  expect(state.attached).toHaveLength(1);
  expect(() =>
    selectRepository(state, { action: "checkout", repository: "org/secondary", ref: "main" }, "42"),
  ).toThrow("preserve its changes");
  // Durable JSON round-trips preserve selection and sandbox identity.
  const restored: WorkspaceState = JSON.parse(JSON.stringify(state));
  expect(activeWorkspace(restored, "42")).toEqual(secondary);
  expect(activeWorkspace(restored, "other-session")?.sandboxId).not.toBe(secondary?.sandboxId);
});

it("can attach a repo to a repo-less workspace without anchoring it or reusing its scratch sandbox", () => {
  const state: WorkspaceState = { config: null };
  expect(activeWorkspace(state, "42")).toBeNull();
  selectRepository(state, { action: "attach", repository: "org/secondary" }, "42");
  expect(state.config).toBeNull();
  expect(activeWorkspace(state, "42")?.sandboxId).toBe("42:repo:org/secondary");
  expect(activeWorkspace(state, "42")?.config.networkHosts).toEqual([]);
});

function packet(command: string) {
  return (new TextEncoder().encode(command).length + 4).toString(16).padStart(4, "0") + command;
}

const branch = "dolly/session-42";

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

it("records fixed checkout phases before potentially blocking operations", () => {
  const script = checkoutScript(workspaceConfig({ repository: "owner/repo" }, "42"));

  for (const [phase, command] of [
    ["resolve_ref", "advertisement=$(git ls-remote"],
    ["artifactfs_mount", "  dolly-mount repo"],
    ["exact_revision_checkout", "  git -C /workspace/checkout init"],
    ["git_config", "git config user.name"],
    ["git_checkout_branch", "dolly-branch"],
    ["ready", "touch /workspace/ready"],
  ]) {
    expect(script.indexOf(`phase ${phase}\n`)).toBeGreaterThan(-1);
    expect(script.indexOf(`phase ${phase}\n`)).toBeLessThan(script.indexOf(command));
  }
});

it("limits ArtifactFS diagnostics to read-only metadata and a bounded daemon log tail", () => {
  expect(checkoutDiagnosticsScript).toContain("tail -c 12288 /workspace/artifact-fs.log");
  expect(checkoutDiagnosticsScript).toContain("ps -eo pid,ppid,stat,etime,comm");
  expect(checkoutDiagnosticsScript).toContain(
    "stat /workspace/artifact-fs/repos/repo/git/index.lock",
  );
  expect(checkoutDiagnosticsScript).not.toMatch(/\brm\b|\bkill\b|\bprintenv\b|ps .*args/);
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
