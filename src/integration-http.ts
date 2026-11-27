import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { exceptionDetails, redact } from "./diagnostics";
import { OperationError, attempt } from "./operations";
import { Buffer } from "node:buffer";
import { LineWindow, type FileRange } from "./file-window";

const ProviderError = Schema.Struct({
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          message: Schema.optional(Schema.String),
          field: Schema.optional(Schema.String),
          code: Schema.optional(Schema.String),
        }),
      ]),
    ),
  ),
});

/** The provider's own explanation, e.g. GitHub's 422 validation errors, read from at most 4 KiB. */
const errorReason = (response: Response) =>
  attempt("integration.error", async () => {
    const reader = response.body?.getReader();

    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      while (size < 4096) {
        const next = await reader.read();

        if (next.done) break;
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    const text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, 4096));
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ProviderError))(text);

    if (Option.isNone(parsed)) return "";

    const details = (parsed.value.errors ?? []).map((item) =>
      Schema.is(Schema.String)(item)
        ? item
        : (item.message ?? [item.field, item.code].filter(Boolean).join(" ")),
    );

    return [parsed.value.message ?? parsed.value.error, ...details]
      .filter(Boolean)
      .join("; ")
      .slice(0, 500);
  }).pipe(Effect.catch(() => Effect.succeed("")));

const GITHUB_API = "https://api.github.com";

/** GitHub answers a renamed or transferred repository's old path with one of these. */
const REDIRECTS = new Set([301, 302, 307, 308]);

const MAX_REDIRECTS = 3;

/** A redirect from GitHub's API to another path on it: a renamed or transferred repository. */
function githubMove(from: string, response: Response) {
  const location = response.headers.get("Location");

  if (
    !REDIRECTS.has(response.status) ||
    !location ||
    !URL.canParse(from) ||
    new URL(from).origin !== GITHUB_API ||
    !URL.canParse(location, from)
  )
    return undefined;
  const next = new URL(location, from);

  return next.origin === GITHUB_API ? next.href : undefined;
}

/**
 * Fetch without following redirects, except an anonymous request's within GitHub's API: a renamed
 * or transferred public repository redirects to its new path on api.github.com. Credentialed
 * requests never follow one: an App token is minted for the owner and repository name the caller
 * gave, after checking that owner against the allowlist, so the caller has to use the new name.
 */
async function fetchFollowingGitHub(url: string, init: RequestInit, signal: AbortSignal) {
  let target = url;
  const anonymous = !new Headers(init.headers).has("Authorization");

  for (let hop = 0; ; hop++) {
    const response = await fetch(target, { ...init, signal, redirect: "manual" });
    const next = githubMove(target, response);

    if (!anonymous || !next || hop >= MAX_REDIRECTS) return { response, url: target };
    await response.body?.cancel().catch(() => {});
    target = next;
  }
}

/** The error a body larger than {@link RESPONSE_LIMIT} fails with. */
export const RESPONSE_TOO_LARGE = "Provider response exceeds 1 MiB";

/** The most of a JSON response that is buffered. */
const RESPONSE_LIMIT = 1_048_576;

type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

/** A JSON body of at most {@link RESPONSE_LIMIT} bytes. */
const readJson = (body: BodyReader) =>
  Effect.gen(function* () {
    const buffer = new Uint8Array(RESPONSE_LIMIT);
    let size = 0;

    while (true) {
      const next = yield* attempt("integration.read", () => body.read());

      if (next.done) break;

      if (size + next.value.byteLength > buffer.byteLength)
        return yield* new OperationError({
          operation: "integration.body",
          message: RESPONSE_TOO_LARGE,
          details: { limit: buffer.byteLength },
        });
      buffer.set(next.value, size);
      size += next.value.byteLength;
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      new TextDecoder().decode(buffer.subarray(0, size)),
    ).pipe(
      Effect.mapError(
        () =>
          new OperationError({
            operation: "integration.json",
            message: "Provider returned invalid JSON",
            details: null,
          }),
      ),
    );
  });

/**
 * A line window of a UTF-8 text body, decoded as it streams: reading stops once the window is
 * full, so memory stays bounded by the window whatever the body's size.
 */
const readWindow = (range: FileRange) => (body: BodyReader) =>
  Effect.gen(function* () {
    const window = new LineWindow(range);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

    const decode = (bytes?: Uint8Array) =>
      attempt("integration.decode", async () =>
        bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode(),
      );

    while (!window.done) {
      const next = yield* attempt("integration.read", () => body.read());

      if (next.done) {
        window.push(yield* decode());
        break;
      }

      window.push(yield* decode(next.value));
    }

    const total = window.totalLines;

    return { ...window.finish(), totalLines: window.done ? undefined : total };
  });

const integrationRequest = Effect.fn("Integration.request")(function* <A>(
  url: string,
  init: RequestInit,
  readBody: (body: BodyReader) => Effect.Effect<A, OperationError>,
) {
  const authorization = new Headers(init.headers).get("Authorization") ?? "";
  const secrets = [authorization, authorization.replace(/^Bearer /, "")];

  return yield* Effect.gen(function* () {
    const { response, url: from } = yield* Effect.acquireRelease(
      attempt("integration.fetch", (signal) => fetchFollowingGitHub(url, init, signal)),
      ({ response: value }) =>
        attempt("integration.close", async () => {
          if (!value.body?.locked) await value.body?.cancel();
        }).pipe(Effect.catch(() => Effect.void)),
      { interruptible: true },
    );

    return yield* Effect.gen(function* () {
      if (!response.ok) {
        const reason = yield* errorReason(response);

        const moved = githubMove(from, response)
          ? ". GitHub moved this repository (renamed or transferred): use its current owner/name"
          : "";

        return yield* new OperationError({
          operation: "integration.response",
          message: `Provider returned HTTP ${response.status}${reason ? `: ${reason}` : ""}${moved}`,
          details: { status: response.status },
        });
      }

      const reader = response.body?.getReader();

      if (!reader)
        return yield* new OperationError({
          operation: "integration.body",
          message: "Provider returned an empty response",
          details: null,
        });

      return yield* Effect.acquireUseRelease(Effect.succeed(reader), readBody, (body) =>
        attempt("integration.cancel", () => body.cancel()).pipe(
          Effect.ensuring(Effect.sync(() => body.releaseLock())),
          Effect.catch(() => Effect.void),
        ),
      );
    });
  }).pipe(
    Effect.scoped,
    Effect.timeout("15 seconds"),
    Effect.mapError((cause) =>
      cause instanceof OperationError
        ? new OperationError({
            operation: cause.operation,
            message: redact(cause.message, secrets),
            details: {
              ...exceptionDetails(cause, secrets),
              status: Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }))(
                cause.details,
              ).pipe(
                Option.map((value) => value.status),
                Option.getOrUndefined,
              ),
            },
          })
        : new OperationError({
            operation: "integration.timeout",
            message: "Provider request timed out",
            details: null,
          }),
    ),
  );
});

export const integrationJson = (url: string, init: RequestInit) =>
  integrationRequest(url, init, readJson);

/** A window of lines of a text response, of any size; see {@link LineWindow}. */
export const integrationWindow = (url: string, init: RequestInit, range: FileRange = {}) =>
  integrationRequest(url, init, readWindow(range));
