import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineTask,
  defineTool,
  type ConversationId,
  type Harness,
  type TaskId,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { ciWaitMessage, type CiWaitOutcome } from "./ci-wait-message";
import type { CiCheck, CiWorkflowRun, PullChecks, WorkflowRunTarget } from "./github";

/**
 * Durable, turn-ending CI waits, after OpenSession's agent-waits. The agent registers one wait and
 * ends its turn. A background Pi task polls GitHub from the Worker between `sleepUntil` naps, so
 * no model, sandbox or open turn is held while CI runs: between polls the Durable Object can idle
 * until its alarm. When there is something to act on, the result arrives in the same session as a
 * new turn, exactly once.
 */

export const CI_WAIT_TOOL_NAMES = ["wait_for", "cancel_wait"] as const;

const MINUTE = 60_000;
const DEFAULT_TIMEOUT_MINUTES = 120;
const MAX_TIMEOUT_MINUTES = 24 * 60;

/** How often running checks are read. */
export const PR_POLL_MS = 30_000;

/** How long a result must hold still before it wakes the agent, so late checks aren't missed. */
export const PR_SETTLE_MS = 45_000;

/** A PR with no checks at all may just not have registered them yet. */
const PR_EMPTY_SETTLE_MS = 2 * MINUTE;
export const RUN_POLL_MS = 45_000;

/** The first look comes sooner, so a run that already finished doesn't cost a full interval. */
const FIRST_POLL_MS = 15_000;

/** Checks that already woke the agent change rarely (an approval, a rerun, a push). */
const UNCHANGED_POLL_MS = 2 * MINUTE;

/** A workflow run the agent names by workflow and ref may have started just before it registered. */
const RUN_LOOKBACK_MS = 15 * MINUTE;

/** A report older than this no longer suppresses a wake. */
const REPORT_TTL_MS = 24 * 60 * MINUTE;

export type CiTarget =
  | { kind: "pr_checks"; repository: string; number: number }
  | { kind: "workflow_run"; repository: string; runId: number }
  | { kind: "workflow_run"; repository: string; workflow: string; ref: string };

/** GitHub reads, run in the Worker with an installation token. They throw on failure. */
export type CiReads = {
  pullChecks(repository: string, number: number): Promise<PullChecks>;
  workflowRun(repository: string, target: WorkflowRunTarget): Promise<CiWorkflowRun | undefined>;
};

type WaitInput = { target: CiTarget; prompt: string; createdAt: number; deadlineAt: number };

type PollState = {
  phase: "poll";
  /** A wake-worthy result and when it was first seen, for the settle window. */
  candidate?: { signature: string; since: number };
  lastError?: string;
  /** What the last successful read showed, for the timeout message. */
  lastSummary?: string;
  /** Set while results still match what an earlier wake reported. */
  unchangedSince?: number;
};

type WaitResult = { outcome: CiWaitOutcome };

type CurrentWait = {
  taskId: TaskId<WaitResult>;
  target: CiTarget;
  prompt: string;
  createdAt: number;
  deadlineAt: number;
};

/** One wait per conversation, plus what the last wake reported so a re-armed wait won't repeat it. */
const CiWaits = defineDoc<{
  current?: CurrentWait;
  reported?: { key: string; signature: string; at: number };
}>({
  kind: "app.ci-waits",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => false,
});

const iso = (at: number) => new Date(at).toISOString();

const short = (sha: string) => sha.slice(0, 7);

export function describeTarget(target: CiTarget) {
  if (target.kind === "pr_checks") return `${target.repository}#${target.number} checks`;

  if ("runId" in target) return `${target.repository} Actions run ${target.runId}`;

  return `${target.repository} ${target.workflow} for ${target.ref}`;
}

/** Same target, same dedupe history: a re-armed wait for the same PR or run. */
const targetKey = (target: CiTarget) => describeTarget(target).toLowerCase();

type CheckState = "pending" | "failed" | "needs_person" | "passed" | "other";

/** Check runs carry status + conclusion; commit statuses carry only a state in `status`. */
export function checkState(check: CiCheck): CheckState {
  const status = check.status;

  if (status === "completed") {
    const conclusion = check.conclusion ?? "";

    if (["failure", "timed_out", "startup_failure"].includes(conclusion)) return "failed";

    if (conclusion === "action_required") return "needs_person";

    if (conclusion === "success") return "passed";

    return conclusion ? "other" : "pending";
  }

  if (status === "success") return "passed";

  if (status === "failure" || status === "error") return "failed";

  return "pending";
}

type Decision =
  | { kind: "poll"; at: number; state: PollState }
  | {
      kind: "deliver";
      outcome: CiWaitOutcome;
      headline: string;
      detail: string;
      signature?: string;
    };

const nextPoll = (input: WaitInput, now: number, interval: number) =>
  Math.min(input.deadlineAt, now + interval);

const named = (checks: CiCheck[]) =>
  checks.map((check) => (check.url ? `${check.name} (${check.url})` : check.name)).join(", ");

/** Decide one poll of a pr_checks wait, after OpenSession's settlement rules. */
export function decidePr(
  input: WaitInput & { target: { kind: "pr_checks" } },
  state: PollState,
  pull: PullChecks,
  reported: string | undefined,
  now: number,
): Decision {
  const pr = `PR #${input.target.number}`;

  if (pull.state !== "open")
    return {
      kind: "deliver",
      outcome: "closed",
      headline: `${pr} is ${pull.state}`,
      detail: `${input.target.repository}#${input.target.number} is ${pull.state}; its checks no longer matter.`,
    };

  const sorted = [...pull.checks].sort((a, b) => a.name.localeCompare(b.name));
  const by = (wanted: CheckState) => sorted.filter((check) => checkState(check) === wanted);
  const failed = by("failed");
  const pending = by("pending");
  const passed = by("passed");
  const needsPerson = by("needs_person");
  const settled = pending.length === 0;

  const summary = `${passed.length} passed, ${failed.length} failed, ${pending.length} pending of ${sorted.length} on ${short(pull.headSha)}`;

  // A failed check is final for its commit, so it wakes the agent while slower checks still run.
  // The settle window then keys on the failed set alone, so later checks finishing don't restart it.
  const signature = settled
    ? [
        pull.headSha,
        ...sorted.map((check) => `${check.name}\0${check.status}\0${check.conclusion}`),
      ].join("\n")
    : [pull.headSha, ...failed.map((check) => check.name)].join("\n");

  const known = reported === signature;

  if (!settled && (failed.length === 0 || known))
    return {
      kind: "poll",
      at: nextPoll(input, now, PR_POLL_MS),
      state: { phase: "poll", lastSummary: summary },
    };

  if (known)
    return {
      kind: "poll",
      at: nextPoll(input, now, UNCHANGED_POLL_MS),
      state: { phase: "poll", lastSummary: summary, unchangedSince: state.unchangedSince ?? now },
    };

  const since = state.candidate?.signature === signature ? state.candidate.since : now;

  if (now - since < (sorted.length === 0 ? PR_EMPTY_SETTLE_MS : PR_SETTLE_MS))
    return {
      kind: "poll",
      at: nextPoll(input, now, PR_POLL_MS),
      state: { phase: "poll", lastSummary: summary, candidate: { signature, since } },
    };

  const waiting = needsPerson.length
    ? ` ${needsPerson.length} waiting on a person, not a fix: ${named(needsPerson)}.`
    : "";

  if (sorted.length === 0)
    return {
      kind: "deliver",
      outcome: "finished",
      headline: `${pr} has no checks`,
      detail: `${pr} reported no checks on ${short(pull.headSha)} for ${Math.round((now - since) / 1000)}s.`,
      signature,
    };

  if (failed.length && !settled)
    return {
      kind: "deliver",
      outcome: "failed",
      headline: `${pr}: ${failed.length} failed, ${pending.length} still running`,
      detail: `${failed.length} check(s) failed on ${short(pull.headSha)} while ${pending.length} still run: ${named(failed)}.${waiting}`,
      signature,
    };

  if (failed.length)
    return {
      kind: "deliver",
      outcome: "failed",
      headline: `${pr}: ${failed.length} of ${sorted.length} checks failed`,
      detail: `Checks settled on ${short(pull.headSha)}: ${summary}. Failed: ${named(failed)}.${waiting}`,
      signature,
    };

  return {
    kind: "deliver",
    outcome: "passed",
    headline: `${pr}: checks passed`,
    detail: `Checks settled on ${short(pull.headSha)}: ${summary}.${waiting}`,
    signature,
  };
}

const FAILED_JOB = new Set(["failure", "timed_out", "startup_failure"]);

/** Decide one poll of a workflow_run wait: wake when it completes or a job fails. */
export function decideRun(
  input: WaitInput,
  state: PollState,
  run: CiWorkflowRun | undefined,
  reported: string | undefined,
  now: number,
): Decision {
  if (!run)
    return {
      kind: "poll",
      at: nextPoll(input, now, RUN_POLL_MS),
      state: { phase: "poll", lastError: "No matching run yet." },
    };

  const failed = run.jobs.filter((job) => FAILED_JOB.has(job.conclusion ?? ""));

  const jobs = failed
    .map((job) => {
      const steps = job.failedSteps.length ? ` [failed step: ${job.failedSteps.join(", ")}]` : "";

      return `${job.name}${steps}${job.url ? ` (${job.url})` : ""}`;
    })
    .join("; ");

  const label = `${run.name} (run ${run.id}, attempt ${run.attempt})`;
  const summary = `${label} is ${run.status} on ${short(run.headSha)}`;

  const signature =
    run.status === "completed"
      ? `${run.id}:${run.attempt}:${run.conclusion}`
      : `${run.id}:${run.attempt}:failed:${failed.map((job) => job.name).join(",")}`;

  const wakes = run.status === "completed" || failed.length > 0;

  if (!wakes || reported === signature)
    return {
      kind: "poll",
      at: nextPoll(input, now, wakes ? UNCHANGED_POLL_MS : RUN_POLL_MS),
      state: wakes
        ? { phase: "poll", lastSummary: summary, unchangedSince: state.unchangedSince ?? now }
        : { phase: "poll", lastSummary: summary },
    };

  if (run.status !== "completed")
    return {
      kind: "deliver",
      outcome: "failed",
      headline: `${run.name}: ${failed.length} job(s) failed, run still going`,
      detail: `${label} has failed job(s) while others still run: ${jobs}. ${run.url}`,
      signature,
    };

  const conclusion = run.conclusion ?? "unknown";

  return {
    kind: "deliver",
    outcome: conclusion === "success" ? "passed" : failed.length ? "failed" : "finished",
    headline: `${run.name} ${conclusion}`,
    detail: `${label} completed: ${conclusion}.${jobs ? ` Failed jobs: ${jobs}.` : ""} ${run.url}`,
    signature,
  };
}

function timedOut(input: WaitInput, state: PollState, now: number): Decision {
  const minutes = Math.round((now - input.createdAt) / MINUTE);
  const what = describeTarget(input.target);

  const detail = [
    state.unchangedSince === undefined
      ? `Timed out after ${minutes} min waiting on ${what}.`
      : `Timed out after ${minutes} min: ${what} hasn't changed since the last wake reported it.`,
    state.lastSummary ? `Last seen: ${state.lastSummary}.` : "",
    state.lastError ? `Last read error: ${state.lastError}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return { kind: "deliver", outcome: "timed_out", headline: `timed out on ${what}`, detail };
}

function runTarget(target: CiTarget & { kind: "workflow_run" }, createdAt: number) {
  const value: WorkflowRunTarget =
    "runId" in target
      ? { runId: target.runId }
      : { workflow: target.workflow, ref: target.ref, createdAfter: createdAt - RUN_LOOKBACK_MS };

  return value;
}

/** Read and decide one poll; read failures keep polling until the deadline. */
async function poll(
  reads: CiReads,
  input: WaitInput,
  state: PollState,
  reported: string | undefined,
  now: number,
) {
  if (now >= input.deadlineAt) return timedOut(input, state, now);
  const target = input.target;

  try {
    if (target.kind === "pr_checks")
      return decidePr(
        { ...input, target },
        state,
        await reads.pullChecks(target.repository, target.number),
        reported,
        now,
      );

    return decideRun(
      input,
      state,
      await reads.workflowRun(target.repository, runTarget(target, input.createdAt)),
      reported,
      now,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const next: Decision = {
      kind: "poll",
      at: nextPoll(input, now, target.kind === "pr_checks" ? PR_POLL_MS : RUN_POLL_MS),
      state: { ...state, lastError: message.slice(0, 300) },
    };

    return next;
  }
}

function ciWaitTask(reads: () => CiReads) {
  return defineTask<WaitInput, { phase: "start" } | PollState, WaitResult>({
    name: "app.ci-wait",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: (task, runtime, context) =>
        runtime.sleepUntil(
          Math.min(task.input.deadlineAt, task.input.createdAt + FIRST_POLL_MS),
          { phase: "poll" },
          context,
        ),
      poll: async (task, runtime, context) => {
        const before = await runtime.snapshot(CiWaits, runtime.conversationId, context);
        const key = targetKey(task.input.target);

        const reported =
          before?.reported?.key === key && runtime.now() - before.reported.at <= REPORT_TTL_MS
            ? before.reported.signature
            : undefined;

        // The read happens outside the commit; a crash before the commit just reads again.
        const decision = await poll(
          reads(),
          task.input,
          task.state.checkpoint,
          reported,
          runtime.now(),
        );

        const conversation = await runtime.conversation(runtime.conversationId, context);

        if (!conversation) throw new Error("CI wait conversation missing");

        await runtime.commit(async (tx) => {
          const waits = await tx.doc(CiWaits, runtime.conversationId);

          // Replaced or cancelled while GitHub answered: never resurrect or deliver a stale wait.
          if (String(waits.current?.taskId) !== String(task.id))
            return { status: "terminal", outcome: { status: "aborted" } };

          if (decision.kind === "poll")
            return { status: "sleeping", until: decision.at, checkpoint: decision.state };

          delete waits.current;

          if (decision.signature !== undefined)
            waits.reported = { key, signature: decision.signature, at: runtime.now() };

          await conversation.submit(tx, {
            type: "input",
            content: ciWaitMessage(String(task.id), {
              outcome: decision.outcome,
              headline: decision.headline,
              detail: decision.detail,
              prompt: task.input.prompt,
            }),
            requestId: `ci-wait:${task.id}`,
            whenBusy: "followUp",
          });

          return {
            status: "terminal",
            outcome: { status: "completed", result: { outcome: decision.outcome } },
          };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const waits = await tx.doc(CiWaits, runtime.conversationId);

        if (String(waits.current?.taskId) === String(task.id)) delete waits.current;

        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
}

type WaitForInput = {
  kind: "pr_checks" | "workflow_run";
  repository: string;
  number?: number;
  run_id?: number;
  workflow?: string;
  ref?: string;
  prompt?: string;
  timeout_minutes?: number;
};

export class CiWaiter {
  readonly task: ReturnType<typeof ciWaitTask>;

  constructor(
    private readonly getHarness: () => Harness,
    private readonly reads: () => CiReads,
    /** Same rule as agent-scheduled prompts: only sessions started from the web app. */
    private readonly allowed: (conversationId: ConversationId) => Promise<boolean>,
    private readonly now: () => number = Date.now,
  ) {
    this.task = ciWaitTask(reads);
  }

  private get harness() {
    return this.getHarness();
  }

  private target(input: WaitForInput): { target: CiTarget } | { error: string } {
    const repository = input.repository.trim();

    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) return { error: "repository must be owner/name" };

    if (input.kind === "pr_checks")
      return input.number === undefined
        ? { error: "pr_checks needs number, the pull request number" }
        : { target: { kind: "pr_checks", repository, number: input.number } };

    if (input.run_id !== undefined)
      return { target: { kind: "workflow_run", repository, runId: input.run_id } };

    const workflow = input.workflow?.trim() ?? "";
    const ref = input.ref?.trim() ?? "";

    if (!workflow || !ref)
      return {
        error:
          "workflow_run needs run_id, or workflow (such as release.yml) plus ref (the branch, tag or commit sha the run was started for)",
      };

    return { target: { kind: "workflow_run", repository, workflow, ref } };
  }

  async waitFor(
    conversationId: ConversationId,
    input: WaitForInput,
    context: Context = BACKGROUND_CONTEXT,
  ) {
    if (!(await this.allowed(conversationId)))
      return { error: "CI waits are only available in sessions started from the web app" };
    const parsed = this.target(input);

    if ("error" in parsed) return parsed;
    const target = parsed.target;
    const now = this.now();
    const minutes = input.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES;

    // A first read up front: a typo'd repository, a missing PR or a repository the App can't read
    // fails now, in the turn, instead of hours later.
    let status: string;

    try {
      if (target.kind === "pr_checks") {
        const pull = await this.reads().pullChecks(target.repository, target.number);
        const states = pull.checks.map(checkState);
        const count = (state: CheckState) => states.filter((value) => value === state).length;

        status = `${pull.state}; ${count("passed")} passed, ${count("failed")} failed, ${count("pending")} pending of ${states.length} on ${short(pull.headSha)}`;
      } else {
        const run = await this.reads().workflowRun(target.repository, runTarget(target, now));

        status = run
          ? `${run.name} (run ${run.id}) is ${run.status}${run.conclusion ? `: ${run.conclusion}` : ""}`
          : "no matching run yet; it will be picked up when it starts";
      }
    } catch (error) {
      return {
        error: `Could not read ${describeTarget(target)}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const conversation = await this.harness.conversation(conversationId, context);

    if (!conversation) return { error: "Session not found" };

    const replaced = await conversation.commit(async (tx) => {
      const waits = await tx.doc(CiWaits, conversationId);
      const previous = waits.current?.taskId;

      const input_: WaitInput = {
        target,
        prompt:
          input.prompt?.trim() ||
          "Inspect the result. Fix failures if needed, then finish the task.",
        createdAt: now,
        deadlineAt: now + minutes * MINUTE,
      };

      const taskId = await tx.createTask(this.task, input_, {
        ownership: { kind: "conversation" },
        background: true,
      });

      waits.current = { taskId, ...input_ };

      return { previous, taskId };
    }, context);

    // The old task finds itself no longer current and ends without delivering; aborting it just
    // stops its next nap early.
    if (replaced.previous) await this.harness.abortTask(replaced.previous, context).catch(() => {});

    return {
      id: String(replaced.taskId),
      waiting_on: describeTarget(target),
      now: status,
      timeout: iso(now + minutes * MINUTE),
      replaced: replaced.previous !== undefined,
      note: "You'll be woken in this session when there's something to act on: a check fails, everything settles, the PR closes, or the wait times out. End your turn now; don't sleep or poll. One wait per session; calling wait_for again replaces it.",
    };
  }

  async current(conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT) {
    const waits = await this.harness.snapshot(CiWaits, conversationId, context);
    const wait = waits?.current;

    return wait
      ? {
          id: String(wait.taskId),
          waiting_on: describeTarget(wait.target),
          timeout: iso(wait.deadlineAt),
        }
      : undefined;
  }

  async cancel(conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT) {
    const wait = await this.current(conversationId, context);

    if (!wait) return { error: "No CI wait is active in this session" };
    const waits = await this.harness.snapshot(CiWaits, conversationId, context);

    if (waits?.current) await this.harness.abortTask(waits.current.taskId, context);

    return { ...wait, state: "cancelled" };
  }

  tools(): ToolRegistration[] {
    const reply = async (result: Promise<unknown>): Promise<ToolExecutionResult> => ({
      output: [{ type: "text", text: JSON.stringify(await result) }],
    });

    return [
      defineTool({
        name: "wait_for",
        description:
          "Wait for CI without holding the turn, then end your turn. Use it instead of sleep or polling after pushing: kind pr_checks watches a pull request's checks (repository owner/name, number); kind workflow_run watches one GitHub Actions run, by run_id or by workflow (file name such as release.yml) plus ref (branch, tag or commit sha), so it can be registered right after a push or tag before the run exists. The Worker polls GitHub and wakes this session with the result as a new message: on the first failed check (so fixing can start while slower checks run), when everything settles, when the PR closes or merges, or at the timeout (default 120 minutes, max 1440). Checks waiting on a person (an approval) never wake it. A re-armed wait for the same PR or run doesn't wake again until something changes. prompt is what to do when woken. One wait per session: calling it again replaces the current one. Only in sessions started from the web app.",
        parameters: obj({
          kind: oneOf(["pr_checks", "workflow_run"]),
          repository: str({ description: "owner/name" }),
          number: opt(int({ minimum: 1, description: "Pull request number, for pr_checks" })),
          run_id: opt(int({ minimum: 1, description: "Actions run id, for workflow_run" })),
          workflow: opt(str({ description: "Workflow file name or id, for workflow_run" })),
          ref: opt(str({ description: "Branch, tag or commit sha, for workflow_run" })),
          prompt: opt(str({ maxLength: 8192 })),
          timeout_minutes: opt(int({ minimum: 1, maximum: MAX_TIMEOUT_MINUTES })),
        }),
        replay: "unsafe",
        executionMode: "sequential",
        execute: (input, api, context) => reply(this.waitFor(api.conversationId, input, context)),
      }),
      defineTool({
        name: "cancel_wait",
        description: "Cancel this session's CI wait, if one is active.",
        parameters: obj({}),
        replay: "unsafe",
        executionMode: "sequential",
        execute: (_, api, context) => reply(this.cancel(api.conversationId, context)),
      }),
    ];
  }
}
