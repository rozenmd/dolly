import {
  defineDoc,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Page,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import {
  AutomationPatch,
  MIN_INTERVAL_MINUTES,
  NewAutomation,
  type Automations,
} from "./automations";

/**
 * The `automations` tool: the agent's way into Settings > Automations, so the owner can say
 * "every weekday at 9, check for stale pull requests" in a session instead of filling the form.
 * Only sessions the owner started from the web app get it; automation runs can't edit automations,
 * and Slack or GitHub threads, which other people steer, can't create work that runs unwatched.
 */

export const AUTOMATION_TOOL_NAME = "automations";

export const AUTOMATION_TOOL_TURN_REFUSAL =
  "The automations tool acts only on a message the owner typed in the web app, and this turn was started by something else (a review handoff, a scheduled prompt, a CI result or another session's message). Ask the owner to request the change in a message of their own, or in Settings > Automations.";

/** How many of the owner's latest messages a conversation remembers as theirs. */
export const OWNER_INPUTS_KEPT = 50;

/**
 * The submissions of the owner's latest messages typed in the web app. The tool runs only while
 * every message the model is answering is one of them: a review handoff, scheduled prompt or CI
 * wake not yet answered carries text the owner didn't write, and may not set up unattended work,
 * even once the owner steers after it.
 */
export const OwnerInputDoc = defineDoc<{ submissions: SubmissionId[] }>({
  kind: "app.owner-inputs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ submissions: [] }),
  checkpointWhen: () => false,
});

/**
 * The user messages the model is answering: from the newest entry back to the last final answer
 * (an assistant message with text, calling no tools). `undefined` if the scan stopped before finding one.
 */
export async function unanswered(
  page: (cursor: Cursor | undefined) => Promise<Page<EntryRecord, Cursor>>,
  limit = 500,
) {
  const inputs: EntryId[] = [];
  let cursor: Cursor | undefined;
  let scanned = 0;

  do {
    const { items, next } = await page(cursor);

    for (const entry of items)
      for (const message of [...(entry.model ?? [])].reverse()) {
        if (message.role === "user") inputs.push(entry.id);
        // An answer has text and calls no tools: a response cut short (by a steer, say) is
        // stored empty, and leaves what it was answering unanswered.
        else if (
          message.role === "assistant" &&
          !message.content.some((block) => block.type === "toolCall") &&
          message.content.some((block) => block.type === "text" && block.text.trim() !== "")
        )
          return inputs;
      }

    scanned += items.length;
    cursor = next;
  } while (cursor && scanned < limit);

  // The whole transcript is unanswered input; past the limit, unknown (refused).
  return cursor ? undefined : inputs;
}

export const AUTOMATION_TOOL_REFUSAL =
  "The automations tool is only available in sessions the owner starts from the web app. Automation runs, sessions spawned by another session, read-only sessions, and Slack or GitHub threads can't list or change automations.";

const Field = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

/**
 * What the model sees: one flat object (see tool-schema.ts). The repository is two flat
 * fields instead of a nested workspace; null clears a field on update.
 */
export const AutomationToolInput = Schema.Struct({
  action: Schema.Literals(["list", "read", "create", "update", "delete", "run"]),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  schedule: Field(Schema.String),
  timeZone: Field(Schema.String),
  runAt: Field(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  repository: Field(Schema.String),
  ref: Schema.optional(Schema.String),
  model: Field(Schema.String),
  mcpServers: Schema.optional(Schema.Array(Schema.String)),
  /** For read: where in the prompt to continue from, in characters. */
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type AutomationToolInput = typeof AutomationToolInput.Type;

export const automationToolDescription = `Manage the owner's automations (Settings > Automations): saved prompts that each start a FRESH session, with no memory of this one, on a cron schedule, once at a set time, or when run by hand. Use them for recurring or unattended work ("every weekday at 9 list stale PRs", "nightly dependency check"); use schedule_prompt instead to continue THIS session later. Actions: list (each automation with the start of its prompt and its latest run); read {id, offset?} (the automation and its recent runs, with its prompt in pages: when promptNext is set, read again with offset: promptNext for the rest); create {name, prompt, and schedule (five-field cron, at most every ${MIN_INTERVAL_MINUTES} minutes) with timeZone (IANA, default UTC), or runAt (ISO 8601 with an offset), or neither for run-by-hand only; optional repository (owner/repo) and ref (a branch; give the repository with it, also on update), readOnly (needs a repository; runs only read and report), model, mcpServers (names from Settings > Connections that runs may use; none by default), enabled}; update {id, any create field; null clears schedule, timeZone, runAt, repository or model}; delete {id}; run {id} starts a run now and returns its session id. Write the prompt for a reader with no context: the repository, what to check, what to produce, and what not to do. Confirm the schedule and time zone with the user when they are ambiguous. Only in sessions the owner starts from the web app.`;

/** The tool's flat fields as an API body: the repository becomes a workspace. */
function payload(input: AutomationToolInput) {
  const { repository, ref } = input;

  return {
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    timeZone: input.timeZone,
    runAt: input.runAt,
    enabled: input.enabled,
    readOnly: input.readOnly,
    model: input.model,
    mcpServers: input.mcpServers,
    workspace: repository ? { repository, ...(ref && { ref }) } : repository,
  };
}

function decode<A, I>(schema: Schema.Codec<A, I>, input: AutomationToolInput, hint: string) {
  // A branch belongs to a repository: alone it would be dropped while the rest saves.
  if (input.ref !== undefined && !input.repository)
    return {
      error: "ref needs the repository it is a branch of: give repository and ref together",
    };
  const body = payload(input);

  try {
    return { value: Schema.decodeUnknownSync(schema)(body) };
  } catch (error) {
    return { error: `${hint}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export const newAutomation = (input: AutomationToolInput) =>
  decode(NewAutomation, input, "create needs a name and a prompt");

export const automationPatch = (input: AutomationToolInput) =>
  decode(AutomationPatch, input, "update needs at least one field to change");

/**
 * Pi keeps the first 50 KiB of a tool's text output. Everything the tool returns stays under
 * this many bytes of JSON, so no result is cut off midway.
 */
export const TOOL_OUTPUT_BYTES = 45_000;

/** How much of each prompt `list` shows; `read` pages through the whole of it. */
export const LIST_PROMPT_CHARS = 160;

/** How much of a run's summary or error `read` shows. */
const RUN_TEXT_CHARS = 200;

/** How many runs and network hosts `read` shows, with counts of the rest. */
const READ_RUNS = 10;
const READ_HOSTS = 20;

const bytes = <T>(value: T) => new TextEncoder().encode(JSON.stringify(value)).length;

const cut = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars)}…` : text;

type Listed = Awaited<ReturnType<Automations["list"]>>[number];

/** An automation as `list` shows it: what it is, when it runs, the start of its prompt. */
function listedAutomation(automation: Listed) {
  const [last] = automation.runs;

  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    readOnly: automation.readOnly,
    ...(automation.schedule !== undefined && { schedule: automation.schedule }),
    ...(automation.timeZone !== undefined && { timeZone: automation.timeZone }),
    ...(automation.runAt !== undefined && { runAt: automation.runAt }),
    ...(automation.nextRunAt !== undefined && { nextRunAt: automation.nextRunAt }),
    ...(automation.workspace && { repository: automation.workspace.repository }),
    prompt: cut(automation.prompt, LIST_PROMPT_CHARS),
    ...(last && {
      lastRun: {
        trigger: last.trigger,
        status: last.status,
        at: last.at,
        ...(last.sessionId !== undefined && { sessionId: last.sessionId }),
      },
    }),
  };
}

/**
 * What `list` returns: every automation, compactly, so every ID stays discoverable. If even the
 * compact form would pass the output limit, each is listed by ID, name and enabled alone.
 */
export function listOutput(automations: readonly Listed[]) {
  const full = {
    automations: automations.map(listedAutomation),
    note: "Prompts are cut short and only the latest run is shown; read an id for the rest.",
  };

  if (bytes(full) <= TOOL_OUTPUT_BYTES) return full;

  return {
    automations: automations.map(({ id, name, enabled }) => ({ id, name, enabled })),
    note: "Too many details to list them all; read an id for the rest.",
  };
}

/**
 * What `read` returns: the automation with its recent runs, and as much of its prompt from
 * `offset` (in characters) as fits the output limit; `promptNext` is where to read on from.
 */
export function readOutput(automation: Listed, offset = 0) {
  const { prompt, runs, workspace, ...definition } = automation;
  const hosts = workspace?.networkHosts ?? [];

  const rest = {
    ...definition,
    ...(workspace && {
      workspace: {
        repository: workspace.repository,
        ...(workspace.ref !== undefined && { ref: workspace.ref }),
        ...(hosts.length > 0 && { networkHosts: hosts.slice(0, READ_HOSTS) }),
        ...(hosts.length > READ_HOSTS && { networkHostsTotal: hosts.length }),
      },
    }),
    runs: runs.slice(0, READ_RUNS).map((run) => ({
      ...run,
      ...(run.summary !== undefined && { summary: cut(run.summary, RUN_TEXT_CHARS) }),
      ...(run.error !== undefined && { error: cut(run.error, RUN_TEXT_CHARS) }),
    })),
    ...(runs.length > READ_RUNS && { runsTotal: runs.length }),
    promptLength: [...prompt].length,
  };

  // Characters by code point, so a page never splits one; the most that fits, by its JSON size.
  const characters = [...prompt];
  const start = Math.min(Math.max(0, Math.trunc(offset)), characters.length);
  const budget = TOOL_OUTPUT_BYTES - bytes(rest) - 200;
  let low = 0;
  let high = characters.length - start;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (bytes(characters.slice(start, start + middle).join("")) <= budget) low = middle;
    else high = middle - 1;
  }

  const next = start + low;

  return {
    ...rest,
    prompt: characters.slice(start, next).join(""),
    ...(start > 0 && { promptOffset: start }),
    ...(next < characters.length && {
      promptNext: next,
      note: "The prompt continues: read again with offset set to promptNext for the rest.",
    }),
  };
}

/**
 * What `create` and `update` return: the saved definition, with the start of its prompt and its
 * latest run, always within the output limit so the model sees the change was saved.
 */
export function savedOutput(automation: Listed) {
  const page = readOutput({
    ...automation,
    prompt: cut(automation.prompt, LIST_PROMPT_CHARS),
    runs: automation.runs.slice(0, 1),
  });

  return {
    ...page,
    promptLength: [...automation.prompt].length,
    note: "Saved. The prompt is cut short here; read the id for all of it.",
  };
}
