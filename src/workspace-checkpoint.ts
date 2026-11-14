import { defineTask, type ConversationId } from "@earendil-works/pi-durable";
import { exceptionDetails } from "./diagnostics";
import type { WorkspaceSnapshot } from "./workspace";

/** Durable run-end work: queued input waits for saves, not individual shell commands. */
export function workspaceCheckpoint(
  save: (sandboxId: string, turnId: string) => Promise<WorkspaceSnapshot | null>,
  reportFailure: (conversationId: ConversationId, message: string) => Promise<void>,
) {
  return defineTask<{ sandboxes: string[]; turnId: string }, { phase: "save" }, null>({
    name: "app.workspace-checkpoint",
    version: 1,
    initial: () => ({ phase: "save" }),
    phases: {
      save: async (task, runtime, context) => {
        const results = await Promise.allSettled(
          task.input.sandboxes.map((sandboxId) => save(sandboxId, task.input.turnId)),
        );

        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [exceptionDetails(result.reason).message] : [],
        );

        if (failures.length) await reportFailure(task.conversationId, failures.join("; "));

        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: failures.length
              ? { status: "failed", error: { message: failures.join("; ") } }
              : { status: "completed", result: null },
          }),
          context,
        );
      },
    },
    abort: (_, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
}
