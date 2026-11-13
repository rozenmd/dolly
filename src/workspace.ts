import { defineDoc } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { Repository } from "./github-contracts";

export const WorkspaceInput = Schema.Struct({
  repository: Repository,
  ref: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(200),
      Schema.isPattern(/^[^\p{Cc}]+$/u),
    ),
  ),
  networkHosts: Schema.optional(
    Schema.Array(
      Schema.String.check(
        Schema.isPattern(/^(?=.{1,253}$)(?=.*[a-zA-Z])[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
      ),
    ),
  ),
});

export type WorkspaceConfig = Omit<typeof WorkspaceInput.Type, "networkHosts" | "ref"> & {
  branch: string;
  ref: string;
  networkHosts: string[];
};

export function workspaceConfig(input: typeof WorkspaceInput.Type, id: string): WorkspaceConfig {
  return {
    repository: input.repository,
    ref: input.ref ?? "HEAD",
    networkHosts: Array.from(input.networkHosts ?? []),
    branch: `dolly/session-${id}`,
  };
}

/** The primary repository stays fixed; additional repositories have isolated checkouts. */
export type WorkspaceState = {
  config: WorkspaceConfig | null;
  attached?: WorkspaceConfig[];
  activeRepository?: string;
};

export const ConversationWorkspace = defineDoc<WorkspaceState>({
  kind: "app.workspace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ config: null }),
  checkpointWhen: () => false,
});

export const WorkspaceRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("repositories") }),
  Schema.Struct({
    action: Schema.Literals(["checkout", "attach"]),
    repository: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(201)),
    ref: WorkspaceInput.fields.ref,
  }),
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("diff") }),
  Schema.Struct({
    action: Schema.Literal("commit"),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  }),
  Schema.Struct({ action: Schema.Literal("push") }),
  Schema.Struct({
    action: Schema.Literal("open_pull_request"),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    body: Schema.String.check(Schema.isMaxLength(32768)),
  }),
]);

/** Selecting a repository never reuses another repository's sandbox or resets a checkout. */
export function selectRepository(
  state: WorkspaceState,
  input: { action: "checkout" | "attach"; repository: string; ref?: string },
  id: string,
) {
  const existing = [state.config, ...(state.attached ?? [])].find(
    (item) => item?.repository.toLowerCase() === input.repository.toLowerCase(),
  );

  if (existing && input.ref && existing.ref !== input.ref)
    throw new Error(
      "This repository already has a checkout at another ref; switch without a ref to preserve its changes",
    );

  if (!existing) {
    const config = workspaceConfig(
      { ...input, networkHosts: state.config?.networkHosts ?? [] },
      id,
    );

    if (!state.config && input.action === "checkout") state.config = config;
    else (state.attached ??= []).push(config);
  }

  state.activeRepository = existing?.repository ?? input.repository;
}

export function activeWorkspace(state: WorkspaceState | null | undefined, id: string) {
  const config =
    state?.attached?.find((item) => item.repository === state.activeRepository) ?? state?.config;

  if (!config) return null;

  const sandboxId =
    config.repository === state?.config?.repository
      ? id
      : `${id}:repo:${config.repository.toLowerCase()}`;

  return { config, sandboxId };
}

/** Configuration is context for the model, not an access grant or a claim that checkout succeeded. */
export function workspacePrompt(state: WorkspaceState | null | undefined) {
  const active = activeWorkspace(state, "context")?.config;

  const selection = {
    primary: state?.config?.repository ?? null,
    active: active?.repository ?? null,
    ref: active?.ref ?? null,
    branch: active?.branch ?? null,
    attached: (state?.attached ?? []).map((repo) => ({
      repository: repo.repository,
      ref: repo.ref,
      branch: repo.branch,
    })),
  };

  return [
    "Repository selection for this session (configuration, not proof of GitHub access or a completed checkout):",
    JSON.stringify(selection),
    state?.config
      ? "When the user refers to this project or its short name, use the configured primary repository above; do not ask them which owner/repository it is. For a coding task, use workspace checkout with that full owner/repository to verify access and prepare or reuse its checkout. This does not reset existing changes."
      : "This session has no primary repository. Use workspace repositories to discover enrolled repos, then attach the one the user names. Ask only if the repository name is unknown or ambiguous.",
    "Shell and relative read_file operations use the active repo's /workspace/repo. Each attachment has its own sandbox. Use workspace attach to activate another repo without replacing the primary or losing changes.",
    "An empty repository discovery/enrolment list does not establish that a known selected repo is inaccessible. Try the selected repo directly with workspace checkout and report the actual authorization or checkout error. Do not treat repository selection as an authorization grant.",
    "If GitHub access is denied, explain the concrete configuration step from the tool result. Never claim that no repository access is available merely because discovery returned an empty list.",
  ].join("\n");
}

/** Values are passed as shell arguments, never interpreted as source. */
export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export type WorkspaceCheckpoint = { branch: string; commit: string };

export function checkoutScript(config: WorkspaceConfig) {
  const remote = shellQuote(`http://github.workspace/${config.repository}.git`);

  return `set -eu
if test -f /workspace/ready; then exit 0; fi
remote=${remote}
ref=${shellQuote(config.ref)}
# Resolve HEAD, short branch names and tags without changing their meaning.
advertisement=$(git ls-remote --symref "$remote" "$ref" "refs/heads/$ref" "refs/tags/$ref")
canonical=$(printf '%s\\n' "$advertisement" | awk -v ref="$ref" '
  $1 == "ref:" { symbolic = $2 }
  $2 == ref { exact = $2 }
  $2 == "refs/heads/" ref { branch = $2 }
  $2 == "refs/tags/" ref { tag = $2 }
  END { if (symbolic) print symbolic; else if (exact) print exact; else if (branch) print branch; else print tag }
')
if test -n "$canonical" && test "$canonical" != HEAD; then
  dolly-mount repo "$remote" "$canonical"
  ln -sfn /workspace/mounts/repo /workspace/repo
else
  # Unadvertised commit IDs have no named ref for ArtifactFS. Retain exact-revision checkout.
  rm -rf /workspace/checkout
  mkdir -p /workspace/checkout
  git -C /workspace/checkout init
  git -C /workspace/checkout remote add origin "$remote"
  git -C /workspace/checkout -c protocol.file.allow=never fetch --no-tags -- origin "$ref"
  git -C /workspace/checkout checkout --detach FETCH_HEAD
  mv /workspace/checkout /workspace/repo
fi
cd /workspace/repo
git config user.name 'Dolly'
git config user.email 'dolly@users.noreply.github.com'
git checkout -B ${shellQuote(config.branch)} HEAD
touch /workspace/ready`;
}

export function restoreScript(repository: string, checkpoint: WorkspaceCheckpoint) {
  return `set -eu
if test -f /workspace/ready; then exit 0; fi
dolly-mount state ${shellQuote(`http://artifacts.workspace/${repository}.git`)} ${shellQuote(`refs/heads/${checkpoint.branch}`)}
test "$(git -C /workspace/mounts/state rev-parse HEAD)" = ${shellQuote(checkpoint.commit)}
mkdir -p /workspace/git /workspace/mounts/state/files
python3 -c 'import os, tarfile; tarfile.open("/workspace/mounts/state/git.tar").extractall("/workspace/git", filter="data"); tarfile.open("/workspace/mounts/state/nested.tar").extractall("/workspace/mounts/state", filter="data"); [os.makedirs(b"/workspace/mounts/state/" + path, exist_ok=True) for path in open("/workspace/mounts/state/directories", "rb").read().split(b"\\0") if path]'
# The user's index, refs, reflogs and dirty files are separate from the checkpoint repository.
printf 'gitdir: /workspace/git\\n' > /workspace/mounts/state/files/.git
ln -sfn /workspace/mounts/state/files /workspace/repo
git -C /workspace/repo config core.worktree /workspace/repo
git -C /workspace/repo config --unset core.fsmonitor || test "$?" = 5
git -C /workspace/repo config --unset core.untrackedCache || test "$?" = 5
touch /workspace/ready`;
}

export function checkpointScript(
  repository: string,
  branch: string,
  previous?: WorkspaceCheckpoint,
) {
  return `python3 /usr/local/lib/dolly-checkpoint.py ${shellQuote(`http://artifacts.workspace/${repository}.git`)} ${shellQuote(branch)} ${shellQuote(previous ? `refs/heads/${previous.branch}` : "")}`;
}
