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
    branch: `pi-hard/session-${id}`,
  };
}

/** Pi owns the immutable repository selection and each conversation's branch. */
export const ConversationWorkspace = defineDoc<{ config: WorkspaceConfig | null }>({
  kind: "app.workspace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ config: null }),
  checkpointWhen: () => false,
});

export const WorkspaceRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("checkout"),
    repository: Repository,
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
  pi-hard-mount repo "$remote" "$canonical"
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
git config user.name 'Pi Hard'
git config user.email 'pi-hard@users.noreply.github.com'
git checkout -B ${shellQuote(config.branch)} HEAD
touch /workspace/ready`;
}

export function restoreScript(repository: string, checkpoint: WorkspaceCheckpoint) {
  return `set -eu
if test -f /workspace/ready; then exit 0; fi
pi-hard-mount state ${shellQuote(`http://artifacts.workspace/${repository}.git`)} ${shellQuote(`refs/heads/${checkpoint.branch}`)}
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
  return `python3 /usr/local/lib/pi-hard-checkpoint.py ${shellQuote(`http://artifacts.workspace/${repository}.git`)} ${shellQuote(branch)} ${shellQuote(previous ? `refs/heads/${previous.branch}` : "")}`;
}
