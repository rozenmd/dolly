import * as Schema from "effect/Schema";
import { request } from "./api";

export const CiWait = Schema.Struct({
  id: Schema.String,
  /** Absent from a Worker that predates session_turn waits. */
  kind: Schema.optional(Schema.Literals(["ci", "session_turn"])),
  waiting_on: Schema.String,
  timeout: Schema.String,
  next_poll: Schema.String,
  last_seen: Schema.optional(Schema.String),
});

export type CiWait = typeof CiWait.Type;

const Current = Schema.Struct({ wait: Schema.NullOr(CiWait) });

const path = (session: string) => `/sessions/${encodeURIComponent(session)}/wait`;

/** The session's background wait (CI or another session's turn), or null when there is none. */
export async function ciWait(session: string, signal?: AbortSignal) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Current))(
    await request(path(session), undefined, signal),
  ).wait;
}

export async function cancelCiWait(session: string) {
  await request(path(session), undefined, undefined, "DELETE");
}
