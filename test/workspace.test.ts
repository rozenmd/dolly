import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  GITHUB_APP_GRANT_PERMISSIONS,
  GITHUB_APP_READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS,
  GITHUB_APP_CODE_PERMISSIONS,
} from "../src/github-permissions";
import { checkedPush, gitRoute, pushRefusal } from "../src/git-transport";
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
const defaultBranch = "main";

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

/** The forwarded body, or null when the push is refused; the request arrives in `size` chunks. */
async function forwarded(text: string, size = Number.POSITIVE_INFINITY) {
  const checked = await checkedPush(fragmented(text, size), defaultBranch);

  return checked.accepted ? new Response(checked.body).text() : null;
}

function fragmented(text: string, size: number) {
  const bytes = new TextEncoder().encode(text);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += size)
        controller.enqueue(bytes.slice(index, index + size));
      controller.close();
    },
  });
}

it("streams an accepted push unchanged across fragmented packets", async () => {
  const text = update(`refs/heads/${branch}`) + "0000PACKbinary-payload";
  expect(await forwarded(text, 3)).toBe(text);
});

it("accepts shallow boundary announcements without relaxing the default branch restriction", async () => {
  const shallow = packet(`shallow ${"c".repeat(40)}\n`);
  const text = shallow + update(`refs/heads/${branch}`) + "0000PACKbinary-payload";
  expect(await forwarded(text)).toBe(text);
  expect(await forwarded(shallow + update("refs/heads/main") + "0000PACK")).toBeNull();
});

it("lets a shallow checkout push a new branch whose pack needs git's probe request", async () => {
  // What git 2.47 sends to push a new branch from a --depth=1 checkout once the default branch
  // has moved on: no commit is shared, so the pack holds the whole tree, and above
  // http.postBuffer git first probes the endpoint with a lone flush packet, then streams the
  // shallow boundary, the creation of the branch and the pack.
  expect(await forwarded("0000")).toBe("0000");
  expect(await forwarded("0000", 1)).toBe("0000");

  const push =
    packet(`shallow ${"c".repeat(40)}\n`) +
    packet(
      `${"0".repeat(40)} ${"b".repeat(40)} refs/heads/${branch}\0 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.47.3`,
    ) +
    "0000PACK" +
    "x".repeat(70_000);

  expect(await forwarded(push, 4096)).toBe(push);
});

it("refuses a probe-shaped body that carries anything besides the flush", async () => {
  for (const text of [
    "00000000",
    "0000PACK",
    packet(`shallow ${"c".repeat(40)}\n`) + "0000",
    packet(`shallow ${"c".repeat(40)}\n`) + "0000PACK",
  ]) {
    expect(await forwarded(text)).toBeNull();
    expect(await forwarded(text, 1)).toBeNull();
  }
});

it("accepts updates, including force pushes, to any branches but the default", async () => {
  // A force push is an update whose old commit is not an ancestor; the request looks the same.
  const text =
    update("refs/heads/investigate-audit-headers-null") +
    update("refs/heads/feature/x", "c".repeat(40)) +
    "0000PACK";

  expect(await forwarded(text)).toBe(text);
});

it("refuses the default branch, tags, deletes and malformed pushes, cancelling rejected bodies", async () => {
  const shallow = packet(`shallow ${"c".repeat(40)}\n`);

  for (const text of [
    update("refs/heads/main") + "0000PACK",
    update("refs/tags/v1") + "0000PACK",
    update(`refs/heads/${branch}`, "0".repeat(40)) + "0000PACK",
    update(`refs/heads/${branch}`) + update("refs/heads/main") + "0000PACK",
    // A shallow push gets no exemption from the branch rules.
    shallow + update("refs/heads/main") + "0000PACK",
    shallow + update("refs/tags/v1") + "0000PACK",
    shallow + update(`refs/heads/${branch}`, "0".repeat(40)) + "0000PACK",
    update(`refs/heads/${branch}`) + shallow + "0000PACK",
    "0000PACK",
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

    expect(await checkedPush(stream, defaultBranch)).toMatchObject({ accepted: false });
    expect(cancelled || !stream.locked).toBe(true);
    expect(stream.locked).toBe(false);
  }
});

it("refuses a push so that git prints the reason", async () => {
  const reason = "Pushes may update any branch except the default branch (main)";

  // A client that asked for a sideband prints channel 3 as `remote: <reason>` and fails.
  expect(
    await checkedPush(new Blob([update("refs/heads/main") + "0000PACK"]).stream(), defaultBranch),
  ).toEqual({
    accepted: false,
    sideband: true,
  });
  const sideband = pushRefusal(reason, true);
  expect(sideband.status).toBe(200);
  expect(sideband.headers.get("Content-Type")).toBe("application/x-git-receive-pack-result");
  expect(await sideband.text()).toBe(packet(`\x03${reason}\n`));

  // Without one there is no channel for it, so the refusal stays a plain 403.
  const plain = packet(`${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main\0report-status\n`);
  expect(await checkedPush(new Blob([plain + "0000PACK"]).stream(), defaultBranch)).toEqual({
    accepted: false,
    sideband: false,
  });
  const refused = pushRefusal(reason, false);
  expect(refused.status).toBe(403);
  expect(await refused.text()).toBe(reason);
});

it("quotes shell values and keeps checkout refs out of shell syntax", () => {
  expect(shellQuote("a'b")).toBe("'a'\\''b'");

  const config = workspaceConfig(
    { repository: "different-owner/project", ref: "main'; touch /tmp/injected; '" },
    "42",
  );

  expect(checkoutScript(config)).toContain("'main'\\''; touch /tmp/injected; '\\'''");
  expect(config.networkHosts).toEqual([]);
});

it("uses only the ordinary local checkout helper, with separately quoted arguments", () => {
  const script = checkoutScript(workspaceConfig({ repository: "owner/repo" }, "42"));

  expect(script).toBe(
    "sh /usr/local/lib/dolly-checkout.sh 'http://github.workspace/owner/repo.git' 'HEAD' 'dolly/session-42'",
  );
});

it("limits local workspace diagnostics to read-only metadata and no process arguments", () => {
  expect(checkoutDiagnosticsScript).toContain("ps -eo pid,ppid,stat,etime,comm");
  expect(checkoutDiagnosticsScript).toContain("stat /workspace/repo/.git/index.lock");
  expect(checkoutDiagnosticsScript).not.toMatch(/\brm\b|\bkill\b|\bprintenv\b|ps .*args/);
});

it("requires explicit acknowledgement for workspace restart but not diagnostics", () => {
  const decode = Schema.decodeUnknownSync(WorkspaceRequest);
  expect(decode({ action: "diagnostics" })).toEqual({ action: "diagnostics" });
  expect(() => decode({ action: "restart" })).toThrow();
  expect(() => decode({ action: "restart", discardUncheckpointed: false })).toThrow();
  expect(decode({ action: "restart", discardUncheckpointed: true })).toMatchObject({
    action: "restart",
  });
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
