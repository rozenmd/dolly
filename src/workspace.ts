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

export function checkoutScript(config: WorkspaceConfig) {
  return `set -eu
if test -d /workspace/repo/.git; then exit 0; fi
mkdir -p /workspace/checkout
cd /workspace/checkout
git init
git config user.name 'Pi Hard'
git config user.email 'pi-hard@users.noreply.github.com'
git remote remove origin 2>/dev/null || true
git remote add origin ${shellQuote(`http://github.workspace/${config.repository}.git`)}
git -c protocol.file.allow=never fetch --no-tags -- origin ${shellQuote(config.ref ?? "HEAD")}
git checkout -B ${shellQuote(config.branch)} FETCH_HEAD
cd /workspace
mv checkout repo`;
}
