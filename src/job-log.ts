import { Buffer } from "node:buffer";
import { READ_BYTES, READ_LINES } from "./file-window";

/** Lines returned when no offset is given: the tail, where a failed job's error usually is. */
export const JOB_LOG_TAIL_LINES = 300;

/** Error annotations reported alongside the window, so the agent can jump to them. */
const MAX_ERRORS = 30;

/** One stored line is cut past this, so a minified bundle or base64 blob cannot fill the window. */
const MAX_LINE = 2_000;

// Actions prefixes every line with an ISO timestamp; colour codes survive in the raw log.
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

// oxlint-disable-next-line no-control-regex -- stripping terminal escape sequences is the point.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const ERROR = /##\[error\]|::error\b/;

function clean(line: string) {
  const text = line.replace(/\r$/, "").replace(TIMESTAMP, "").replace(ANSI, "");

  return text.length > MAX_LINE
    ? `${text.slice(0, MAX_LINE)}…[cut ${text.length - MAX_LINE} characters]`
    : text;
}

export type JobLogRange = { readonly offset?: number; readonly limit?: number };

export type JobLog = {
  total_lines: number;
  start_line: number;
  end_line: number;
  /** Where to continue reading forward, when lines remain past the window. */
  next_offset: number | null;
  /** Error annotations (##[error]) anywhere in the log, by line, capped. */
  errors: { line: number; text: string }[];
  errors_truncated: boolean;
  content: string;
};

/**
 * Selects a window of a GitHub Actions job log while it streams, holding only the window in
 * memory. Without an offset it keeps the tail; with one it reads forward like read_file. Either
 * way it reports the total line count and where the error annotations are.
 */
export class JobLogWindow {
  private partial = "";
  private total = 0;
  private readonly lines: { line: number; text: string }[] = [];
  private readonly errors: { line: number; text: string }[] = [];
  private errorCount = 0;
  private readonly offset: number | undefined;
  private readonly limit: number;

  constructor(range: JobLogRange = {}) {
    this.offset = range.offset;
    this.limit = Math.min(
      range.limit ?? (range.offset ? READ_LINES : JOB_LOG_TAIL_LINES),
      READ_LINES,
    );
  }

  push(chunk: string) {
    const text = this.partial + chunk;
    let start = 0;

    while (true) {
      const end = text.indexOf("\n", start);

      if (end < 0) break;
      this.take(text.slice(start, end));
      start = end + 1;
    }

    this.partial = text.slice(start);

    // An unterminated line cannot grow without bound; keep only what clean() would keep.
    if (this.partial.length > MAX_LINE * 4) this.partial = this.partial.slice(0, MAX_LINE * 4);
  }

  private take(raw: string) {
    this.total += 1;
    const line = this.total;
    const text = clean(raw);

    if (ERROR.test(text)) {
      this.errorCount += 1;

      if (this.errors.length < MAX_ERRORS) this.errors.push({ line, text });
    }

    if (this.offset === undefined) {
      this.lines.push({ line, text });

      if (this.lines.length > this.limit) this.lines.shift();
    } else if (line >= this.offset && line < this.offset + this.limit)
      this.lines.push({ line, text });
  }

  finish(): JobLog {
    if (this.partial) this.take(this.partial);
    this.partial = "";

    // Fit the byte budget: a tail drops its oldest lines, a forward read its newest.
    let kept = [...this.lines];
    let bytes = kept.reduce((sum, entry) => sum + Buffer.byteLength(entry.text) + 1, 0);

    while (bytes > READ_BYTES && kept.length > 1) {
      const dropped = this.offset === undefined ? kept.shift() : kept.pop();

      bytes -= Buffer.byteLength(dropped?.text ?? "") + 1;
    }

    if (bytes > READ_BYTES)
      kept = kept.map((entry) => ({ ...entry, text: entry.text.slice(0, READ_BYTES) }));

    const first = kept[0]?.line ?? Math.min(this.offset ?? 1, this.total + 1);
    const last = kept.at(-1)?.line ?? first - 1;

    return {
      total_lines: this.total,
      start_line: first,
      end_line: last,
      next_offset: last < this.total ? last + 1 : null,
      errors: this.errors,
      errors_truncated: this.errorCount > this.errors.length,
      content: kept.map((entry) => entry.text).join("\n"),
    };
  }
}
