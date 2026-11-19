import * as Schema from "effect/Schema";
import { request } from "./api";

export const CiWait = Schema.Struct({
  id: Schema.String,
  waiting_on: Schema.String,
  timeout: Schema.String,
  next_poll: Schema.String,
  last_seen: Schema.optional(Schema.String),
});

export type CiWait = typeof CiWait.Type;

const Current = Schema.Struct({ wait: Schema.NullOr(CiWait) });

const path = (session: string) => `/sessions/${encodeURIComponent(session)}/wait`;

/** The session's active CI wait, or null when the agent isn't waiting on CI. */
export async function ciWait(session: string, signal?: AbortSignal) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Current))(
    await request(path(session), undefined, signal),
  ).wait;
}

export async function cancelCiWait(session: string) {
  await request(path(session), undefined, undefined, "DELETE");
}
