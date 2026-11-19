import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  Block,
  HistoryPage,
  PromptIndex,
  Message,
  Snapshot,
  Live,
  FallbackNote,
  type RunFailure,
} from "../../../src/transcript";
import { SPEEDS, type Speed } from "../../../src/model-capabilities";
import { parseScheduledMessage } from "../../../src/schedule-message";
import { parseCiWaitMessage, type CiWaitOutcome } from "../../../src/ci-wait-message";

export { Snapshot } from "../../../src/transcript";

export function liveFromSnapshot(snapshot: typeof Snapshot.Type) {
  return Option.getOrNull(Schema.decodeUnknownOption(Live)(snapshot.docs["pi.live"]));
}

const QueuedInput = Schema.Struct({
  id: Schema.Number,
  mode: Schema.Literals(["followUp", "steer"]),
  content: Schema.Union([Schema.String, Schema.Array(Block)]),
});

export type QueuedMessage = { id: number; text: string; steering: boolean };

export function queueFromSnapshot(snapshot: typeof Snapshot.Type): QueuedMessage[] {
  const inbox = Schema.decodeUnknownOption(Schema.Struct({ items: Schema.Array(Schema.Unknown) }))(
    snapshot.docs["pi.inbox"],
  );

  if (Option.isNone(inbox)) return [];

  return inbox.value.items.flatMap((item) => {
    const input = Schema.decodeUnknownOption(QueuedInput)(item);

    if (Option.isNone(input)) return [];

    return [
      {
        id: input.value.id,
        text: messageText({ role: "user", content: input.value.content }),
        steering: input.value.mode === "steer",
      },
    ];
  });
}

export const Session = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  model: Schema.String,
  thinkingLevel: Schema.optional(Schema.String),
  speed: Schema.optional(Schema.Literals(SPEEDS)),
  autoFallback: Schema.optional(Schema.Boolean),
});

export { SavedSession } from "../../../src/session-contracts";

import { SavedSession } from "../../../src/session-contracts";

const WorkspaceSelection = Schema.Struct({
  repository: Schema.String,
  ref: Schema.optional(Schema.String),
  networkHosts: Schema.optional(Schema.Array(Schema.String)),
});

export function sessionBody(source: SavedSession, snapshot: typeof Snapshot.Type | null): ApiBody {
  // Model, effort, speed and auto-fallback start from the owner's defaults, not the open session.
  const body: ApiBody = {};
  const state = snapshot?.docs["app.workspace"];

  if (state !== undefined) {
    const context = Schema.decodeUnknownOption(
      Schema.Struct({ config: Schema.NullOr(WorkspaceSelection) }),
    )(state);

    if (Option.isSome(context)) {
      if (context.value.config) body.workspace = context.value.config;

      return body;
    }
  }

  if (source.repository) {
    body.workspace = { repository: source.repository };

    if (source.ref) body.workspace.ref = source.ref;
  }

  return body;
}

export type Step = {
  id: string;
  name: string;
  detail: string;
  output: string;
  images?: string[];
  status: "pending" | "running" | "done" | "error";
  /** The file a step reads or writes, shown as a file label instead of raw detail. */
  file?: { prefix: string; path: string };
  /** Lines a file tool added and removed, from its result (`+added -removed`). */
  diff?: DiffStats;
  /** When the model issued the call and when its result arrived, for the step's duration. */
  startedAt?: number;
  endedAt?: number;
};

export type DiffStats = { added: number; removed: number };

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A file tool's result, such as write_file's or edit_file's `{ path, added, removed }`. */
const DiffResult = Schema.fromJsonString(Schema.Struct({ added: Count, removed: Count }));

function stepDiff(output: string) {
  const result = Option.getOrUndefined(Schema.decodeUnknownOption(DiffResult)(output));

  return result && { added: result.added, removed: result.removed };
}

/** Total lines added and removed by steps, or undefined when no step changed a file. */
export function diffTotal(steps: readonly Step[]): DiffStats | undefined {
  const diffs = steps.flatMap((step) => (step.diff ? [step.diff] : []));

  if (diffs.length === 0) return undefined;

  return {
    added: diffs.reduce((sum, diff) => sum + diff.added, 0),
    removed: diffs.reduce((sum, diff) => sum + diff.removed, 0),
  };
}

export type TurnItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "steps"; id: string; steps: Step[] }
  /** The session ran out of usage on `from` and switched to `to` (auto-fallback). */
  | { kind: "fallback"; id: string; from: string; to: string };

export type Turn = {
  id: string;
  prompt?: {
    text: string;
    at?: number;
    images?: number;
    /** Delivered by a schedule rather than typed: shown as a notice, not the owner's bubble. */
    scheduled?: { id: string; at: number };
    /** A CI wait's wake-up, written for the model: shown as a notice of its outcome. */
    ciWait?: { outcome: CiWaitOutcome; headline: string; trigger: string };
  };
  items: TurnItem[];
  answer?: { id: string; text: string };
  steps: number;
  startedAt?: number;
  endedAt?: number;
  running: boolean;
  activity?: string;
  failure?: typeof RunFailure.Type;
  retry?: { readonly at: number; readonly error: string };
};

function messageText(message: typeof Message.Type) {
  return Schema.is(Schema.String)(message.content)
    ? message.content
    : message.content.flatMap((block) => (block.text ? [block.text] : [])).join("\n\n");
}

const ToolArguments = Schema.Struct({
  action: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  file_path: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});

const ScheduleArguments = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  in_minutes: Schema.optional(Schema.Number),
  at: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

/** When a schedule_prompt call fires, then what it says: `in 2h · Start the migration…`. */
function scheduleDetail(block: typeof Block.Type) {
  const args = Option.getOrUndefined(
    Schema.decodeUnknownOption(ScheduleArguments)(block.arguments),
  );

  if (!args) return "";

  if (block.name === "cancel_scheduled_prompt") return args.id ?? "";

  const minutes = args.in_minutes;

  const when =
    minutes === undefined
      ? args.at
      : minutes < 60 || minutes % 60
        ? `in ${minutes}m`
        : `in ${minutes / 60}h`;

  return [when, args.prompt].filter(Boolean).join(" · ");
}

const WaitArguments = Schema.Struct({
  repository: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Number),
  run_id: Schema.optional(Schema.Number),
  workflow: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
});

/** What a wait_for call watches: `owner/repo#12` or `owner/repo release.yml @ v1.2.0`. */
function waitDetail(block: typeof Block.Type) {
  const args = Option.getOrUndefined(Schema.decodeUnknownOption(WaitArguments)(block.arguments));

  if (!args?.repository) return "";

  if (args.number !== undefined) return `${args.repository}#${args.number}`;

  if (args.run_id !== undefined) return `${args.repository} run ${args.run_id}`;

  return [args.repository, args.workflow, args.ref && `@ ${args.ref}`].filter(Boolean).join(" ");
}

const OperationArguments = Schema.Struct({ operation: Schema.Unknown });

/**
 * The most recognisable arguments of a tool call, such as its command or file
 * path, prefixed by the action for multi-action tools (`checkout owner/repo`).
 */
function stepArguments(block: typeof Block.Type) {
  const nested = Option.getOrUndefined(
    Schema.decodeUnknownOption(OperationArguments)(block.arguments),
  );

  const args = Option.getOrUndefined(
    Schema.decodeUnknownOption(ToolArguments)(nested?.operation ?? block.arguments),
  );

  return args;
}

function stepDetail(block: typeof Block.Type): Pick<Step, "detail" | "file"> {
  if (block.name === "schedule_prompt" || block.name === "cancel_scheduled_prompt")
    return { detail: scheduleDetail(block) };

  if (block.name === "wait_for") return { detail: waitDetail(block) };

  const args = stepArguments(block);

  if (!args) return { detail: "" };

  const target =
    args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url;

  const prefix = [args.action, args.repository].filter(Boolean).join(" ");
  const detail = [prefix, target].filter(Boolean).join(" ");
  const path = args.file_path ?? args.path;

  // Preview's `path` is a URL path, not a file.
  return args.command === undefined && path && block.name !== "preview"
    ? { detail, file: { prefix, path } }
    : { detail };
}

/** Groups a flat Pi transcript into prompt/response turns, folding tool calls into steps. */
export function turnsFromSnapshot(snapshot: typeof Snapshot.Type): Turn[] {
  const turns: Turn[] = [];
  const calls = new Map<string, Step>();
  const entryTurns = new Map<number, Turn>();
  const live = liveFromSnapshot(snapshot);

  function current(id: string) {
    const last = turns.at(-1);

    if (last) return last;

    const turn: Turn = { id, items: [], steps: 0, running: false };
    turns.push(turn);

    return turn;
  }

  // A group is keyed by its first tool call, which keeps the same id while a
  // message streams live and after it is saved, so the UI never remounts it.
  function addStep(turn: Turn, step: Step) {
    const last = turn.items.at(-1);

    if (last?.kind === "steps") last.steps.push(step);
    else turn.items.push({ kind: "steps", id: `steps-${step.id}`, steps: [step] });

    turn.steps += 1;
    calls.set(step.id, step);
  }

  function touch(turn: Turn, at?: number) {
    if (at === undefined) return;

    turn.startedAt ??= at;
    turn.endedAt = at;
  }

  function add(message: typeof Message.Type, id: string) {
    if (message.role === "user") {
      const text = messageText(message);
      const scheduled = parseScheduledMessage(text);
      const wake = parseCiWaitMessage(text);

      const prompt: NonNullable<Turn["prompt"]> = {
        text: scheduled?.prompt ?? wake?.prompt ?? text,
        at: message.timestamp,
      };

      if (scheduled) prompt.scheduled = { id: scheduled.id, at: scheduled.at };

      if (wake)
        prompt.ciWait = { outcome: wake.outcome, headline: wake.headline, trigger: wake.trigger };

      const images = Schema.is(Schema.String)(message.content)
        ? 0
        : message.content.filter((block) => block.type === "image").length;

      if (images) prompt.images = images;

      turns.push({
        id,
        prompt,
        items: [],
        steps: 0,
        running: false,
      });

      return;
    }

    // System/context entries are model input, not an assistant response.
    if (message.role !== "assistant" && message.role !== "toolResult") return;
    const turn = current(id);
    touch(turn, message.timestamp);

    if (
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage)
    ) {
      turn.failure = {
        reason: message.stopReason === "aborted" ? "aborted" : "model_error",
        detail: message.errorMessage || "The model response ended before completing an answer.",
      };
    } else if (message.role === "assistant") delete turn.failure;

    if (message.role === "toolResult") {
      const step = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      const output = messageText(message);
      const status = message.isError ? "error" : "done";

      const images = Schema.is(Schema.String)(message.content)
        ? []
        : message.content.flatMap((block) => {
            const match =
              block.type === "image" && block.data
                ? /^r2:\/\/screenshots\/(png|jpeg|gif|webp)\/([a-f0-9]{64})$/.exec(block.data)
                : null;

            return match ? [`/api/screenshots/${match[1]}/${match[2]}`] : [];
          });

      const imageOutput = images.length ? { images } : {};

      const target: Step = step ?? {
        id: message.toolCallId ?? id,
        name: message.toolName ?? "tool",
        detail: "",
        output,
        status,
      };

      Object.assign(target, { output, status, ...imageOutput });

      if (message.timestamp !== undefined) target.endedAt = message.timestamp;

      if (!step) addStep(turn, target);

      return;
    }

    if (Schema.is(Schema.String)(message.content)) {
      if (message.content) turn.items.push({ kind: "text", id, text: message.content });

      return;
    }

    for (const [index, block] of message.content.entries()) {
      const blockId = `${id}-${index}`;

      if (block.type === "toolCall" && block.name) {
        const step: Step = {
          id: block.id ?? blockId,
          name: block.name,
          ...stepDetail(block),
          output: "",
          status: "running",
        };

        if (message.timestamp !== undefined) step.startedAt = message.timestamp;
        addStep(turn, step);
      } else if (block.text) {
        const last = turn.items.at(-1);

        if (last?.kind === "text") last.text += `\n\n${block.text}`;
        else turn.items.push({ kind: "text", id: blockId, text: block.text });
      }
    }
  }

  for (const entry of snapshot.entries) {
    const fallback =
      entry.kind === "dolly.fallback"
        ? Option.getOrUndefined(Schema.decodeUnknownOption(FallbackNote)(entry.data))
        : undefined;

    if (fallback)
      current(String(entry.id)).items.push({
        kind: "fallback",
        id: String(entry.id),
        from: fallback.from,
        to: fallback.to,
      });

    for (const [index, message] of (entry.model ?? []).entries())
      add(message, `${entry.id}-${index}`);
    const turn = turns.at(-1);

    if (turn) entryTurns.set(entry.id, turn);
  }

  if (live?.generation?.message) add(live.generation.message, "live");

  for (const tool of live?.tools ?? []) {
    const step = calls.get(tool.callId);

    const status: Step["status"] =
      tool.status === "done" || tool.status === "error" || tool.status === "pending"
        ? tool.status
        : "running";

    if (step) Object.assign(step, { status, output: tool.output ?? step.output });
    else if (status !== "done")
      addStep(current("live"), {
        id: tool.callId,
        name: tool.name,
        detail: "",
        output: tool.output ?? "",
        status,
      });
  }

  const last = turns.at(-1);

  if (last && live?.run) {
    last.running = true;
    delete last.failure;

    const activeTool = live.tools?.find((tool) => tool.status === "running");
    const message = live.generation?.message;
    last.activity = activeTool
      ? `Running ${activeTool.name}`
      : message && messageText(message)
        ? "Responding"
        : live.generation
          ? "Thinking"
          : "Working";
  }

  if (last && live?.generation?.retry) last.retry = live.generation.retry;

  if (live?.runFailure) {
    const failure = live.runFailure;
    const failedTurn = failure.first === undefined ? undefined : entryTurns.get(failure.first);
    const target = failedTurn ?? (!live.run ? (last ?? current("failure")) : undefined);

    if (target) target.failure = failure;
  }

  for (const turn of turns) {
    const tail = turn.items.at(-1);

    if (!turn.running && !turn.failure && tail?.kind === "text") {
      turn.items.pop();
      turn.answer = { id: tail.id, text: tail.text };
    }

    for (const item of turn.items)
      if (item.kind === "steps")
        for (const step of item.steps) {
          if (!turn.running && (step.status === "running" || step.status === "pending"))
            step.status = "done";

          const diff = step.status === "done" ? stepDiff(step.output) : undefined;

          if (diff) step.diff = diff;
        }
  }

  return turns;
}

export type ApiBody = {
  workspaceId?: string;
  sessions?: readonly SavedSession[];
  archived?: boolean;
  kept?: boolean;
  content?: string;
  requestId?: string;
  /** When a scheduled message is sent, as ISO 8601. */
  at?: string;
  images?: readonly { mimeType: string; data: string }[];
  model?: string | null;
  thinkingLevel?: string | null;
  speed?: Speed | null;
  autoFallback?: boolean | null;
  workspace?: { repository: string; ref?: string; networkHosts?: readonly string[] };
  repository?: string;
  owner?: string;
  ownerType?: "personal" | "organization";
  ingress?: string;
  url?: string;
  accounts?: readonly string[];
  senders?: readonly string[];
  token?: string;
  enabled?: boolean;
  botToken?: string;
  signingSecret?: string;
  allowedUserId?: string;
  defaultRepository?: string;
  callbackUrl?: string;
};

export const DefaultModel = Schema.Struct({
  /** The owner's saved choice; `null` means the built-in default. */
  model: Schema.NullOr(Schema.String),
  /** What a new session without a model would use right now. */
  effective: Schema.String,
  /** Effort, speed and auto-fallback new sessions start with. */
  thinkingLevel: Schema.String,
  speed: Schema.Literals(SPEEDS),
  autoFallback: Schema.Boolean,
  /** The ChatGPT login is on a plan that serves Ultrafast (Pro). */
  ultrafastAvailable: Schema.Boolean,
});

export type DefaultModel = typeof DefaultModel.Type;

/** A change to the defaults for new sessions; `null` restores one built-in default. */
export type DefaultModelChange = {
  model?: string | null;
  thinkingLevel?: string | null;
  speed?: Speed | null;
  autoFallback?: boolean | null;
};

/** Reads the defaults for new sessions, or saves a change to them. */
export async function defaultModel(change?: DefaultModelChange) {
  const text =
    change === undefined
      ? await request("/settings/model")
      : await request("/settings/model", change, undefined, "PUT");

  return Schema.decodeUnknownSync(Schema.fromJsonString(DefaultModel))(text);
}

export async function anthropicStatus() {
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ connected: Schema.Boolean })),
  )(await request("/auth/anthropic"));
}

export const ChatGPTStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["connected", "not_connected", "expired"]) }),
  Schema.Struct({
    state: Schema.Literal("awaiting_redirect"),
    authorizeUrl: Schema.String,
    redirectUri: Schema.String,
    expiresAt: Schema.Number,
  }),
]);

export type ChatGPTStatus = typeof ChatGPTStatus.Type;

/** Reads, starts (POST) or cancels and signs out of (DELETE) Sign in with ChatGPT. */
export async function chatgptLogin(method: "GET" | "POST" | "DELETE" = "GET") {
  const text = await request("/auth/chatgpt", undefined, undefined, method);

  return Schema.decodeUnknownSync(Schema.fromJsonString(ChatGPTStatus))(text);
}

/** Finishes sign-in with the address ChatGPT redirected the browser to. */
export async function completeChatGPTLogin(callbackUrl: string) {
  const text = await request("/auth/chatgpt", { callbackUrl }, undefined, "PUT");

  return Schema.decodeUnknownSync(Schema.fromJsonString(ChatGPTStatus))(text);
}

const GitHubApp = Schema.Union([
  Schema.Struct({ connected: Schema.Literal(false) }),
  Schema.Struct({
    connected: Schema.Literal(true),
    owner: Schema.String,
    appSlug: Schema.String,
    installUrl: Schema.String,
    settingsUrl: Schema.String,
    ingress: Schema.NullOr(Schema.String),
    senders: Schema.Array(Schema.String),
  }),
]);

export const AuthState = Schema.Struct({
  github: GitHubApp,
  ownerClaimed: Schema.Boolean,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});

export type AuthState = typeof AuthState.Type;

/** Whether a GitHub App exists, whether dolly has an owner, and who this browser is signed in as. */
/** Up to one page of transcript entries at or before `through`, oldest first. */
export async function historyPage(session: string, through: number, signal?: AbortSignal) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(HistoryPage))(
    await request(
      `/sessions/${encodeURIComponent(session)}/history?through=${through}`,
      undefined,
      signal,
    ),
  );
}

/** Every prompt at or before `through`, oldest first: the rail's marks for turns not yet loaded. */
export async function promptIndex(session: string, through: number, signal?: AbortSignal) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(PromptIndex))(
    await request(
      `/sessions/${encodeURIComponent(session)}/prompts?through=${through}`,
      undefined,
      signal,
    ),
  ).prompts;
}

export async function authState() {
  return Schema.decodeUnknownSync(Schema.fromJsonString(AuthState))(await request("/auth"));
}

export const GitHubSignIn = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("awaiting_code"),
    verificationUri: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.Number,
    pollAfterSeconds: Schema.Number,
  }),
  Schema.Struct({ state: Schema.Literal("expired") }),
  Schema.Struct({ state: Schema.Literal("signed_in"), login: Schema.String }),
]);

export type GitHubSignIn = typeof GitHubSignIn.Type;

/** Starts (POST) or checks (GET) this browser's GitHub device sign-in. */
export async function githubSignIn(method: "GET" | "POST" = "GET") {
  const text = await request("/auth/github", undefined, undefined, method);

  return Schema.decodeUnknownSync(Schema.fromJsonString(GitHubSignIn))(text);
}

/** A failed API call, keeping the HTTP status so callers can tell a refusal from an outage. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request(
  path: string,
  body?: ApiBody,
  signal?: AbortSignal,
  method: "GET" | "POST" | "PUT" | "DELETE" = body ? "POST" : "GET",
) {
  const headers = new Headers();

  if (body) headers.set("Content-Type", "application/json");

  const init: RequestInit = {
    method,
    headers,
    signal,
    credentials: "same-origin",
    redirect: "error",
  };

  if (body) init.body = JSON.stringify(body);

  const response = await fetch(`/api${path}`, init);

  const text = await response.text();

  if (response.ok && !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The API did not return JSON. Check that /api routes to the dolly Worker.");
  }

  if (!response.ok) {
    const error = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Union([
          Schema.Struct({ error: Schema.String }),
          Schema.Struct({ message: Schema.String }),
        ]),
      ),
    )(text).pipe(Option.map((value) => ("error" in value ? value.error : value.message)));

    throw new RequestError(
      Option.getOrElse(error, () => `Request failed (${response.status}). Check your connection.`),
      response.status,
    );
  }

  return text;
}

export function readSessions(value: string): readonly SavedSession[] {
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(SavedSession)))(
    value,
  );

  return Option.getOrElse(result, () => []);
}

const UsageWindow = Schema.Struct({
  label: Schema.String,
  usedPercent: Schema.Finite,
  resetsAt: Schema.NullOr(Schema.Finite),
});

const UsageReport = Schema.Struct({
  providerId: Schema.Literals(["openai", "anthropic"]),
  connected: Schema.Boolean,
  usage: Schema.NullOr(
    Schema.Struct({
      windows: Schema.Array(UsageWindow),
      observedAt: Schema.Finite,
      source: Schema.Literals(["live", "headers"]),
    }),
  ),
  error: Schema.optional(Schema.String),
});

export type UsageReport = typeof UsageReport.Type;

/** Subscription limits per provider; `refresh` asks each provider for current numbers. */
export async function usage(refresh = false) {
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ providers: Schema.Array(UsageReport) })),
  )(await request(refresh ? "/usage?refresh=1" : "/usage")).providers;
}
