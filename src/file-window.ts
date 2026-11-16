import { Buffer } from "node:buffer";

/** Default window, matching the read tool of pi and Open Session: 2,000 lines or 50 KiB. */
export const READ_LINES = 2000;
export const READ_BYTES = 50 * 1024;

export type FileRange = { readonly offset?: number; readonly limit?: number };

export type FileWindow = {
  /** The selected lines, each with its original line ending. */
  readonly text: string;
  readonly startLine: number;
  /** The last line included; startLine - 1 when the window is empty. */
  readonly endLine: number;
  /** Where to continue reading, when lines remain past the window. */
  readonly nextOffset: number | undefined;
  /** The single line in the window was longer than the byte budget and was cut. */
  readonly lineCut: boolean;
};

/**
 * Select a line range from incrementally decoded text, so large files are read
 * a window at a time rather than refused. Memory stays bounded by the byte budget,
 * including for a single enormous line.
 */
export class LineWindow {
  private line = 1;
  private bytes = 0;
  private readonly lines: string[] = [];
  private partial = "";
  /** An unterminated line before the window whose text was discarded. */
  private skipping = false;
  private lineCut = false;
  private nextOffset: number | undefined;
  done = false;
  private readonly offset: number;
  private readonly limit: number;

  constructor(
    range: FileRange = {},
    private readonly maxBytes = READ_BYTES,
  ) {
    this.offset = range.offset ?? 1;
    this.limit = Math.min(range.limit ?? READ_LINES, READ_LINES);
  }

  /** Feed the next decoded chunk; returns true once the window is complete. */
  push(chunk: string) {
    if (this.done) return true;
    const text = this.partial + chunk;
    let start = 0;

    while (!this.done) {
      const end = text.indexOf("\n", start);

      if (end < 0) break;
      this.take(text.slice(start, end + 1));
      start = end + 1;
    }

    this.partial = this.done ? "" : text.slice(start);

    if (!this.done) {
      // Only newlines matter before the window; inside it, cap an unterminated line.
      if (this.line < this.offset) {
        this.skipping = this.skipping || this.partial !== "";
        this.partial = "";
      } else if (Buffer.byteLength(this.partial) > this.maxBytes - this.bytes) {
        this.take(this.partial);
        this.partial = "";
      }
    }

    return this.done;
  }

  finish(): FileWindow {
    if (!this.done && this.partial) this.take(this.partial);

    return {
      text: this.lines.join(""),
      startLine: this.offset,
      endLine: this.offset + this.lines.length - 1,
      nextOffset: this.nextOffset,
      lineCut: this.lineCut,
    };
  }

  /** Lines seen so far; the total once the whole file has been fed. */
  get totalLines() {
    return this.line - 1 + (this.partial || this.skipping ? 1 : 0);
  }

  private take(line: string) {
    if (this.line < this.offset) {
      this.skipping = false;
      this.line++;

      return;
    }

    const size = Buffer.byteLength(line);

    if (this.lines.length >= this.limit || this.bytes + size > this.maxBytes) {
      if (this.lines.length === 0) {
        // A single line larger than the budget: return its start rather than nothing.
        this.lines.push(Buffer.from(line).subarray(0, this.maxBytes).toString());
        this.lineCut = true;
        this.nextOffset = this.line + 1;
      } else this.nextOffset = this.line;
      this.done = true;

      return;
    }

    this.lines.push(line);
    this.bytes += size;
    this.line++;
  }
}

/** Window an already decoded file. */
export function windowText(text: string, range: FileRange = {}) {
  const window = new LineWindow(range);

  window.push(text);
  const total = window.totalLines;

  return { ...window.finish(), totalLines: window.done ? undefined : total };
}

/** The window's text plus a continuation note, for model-facing tool output. */
export function describeWindow(window: FileWindow, totalLines?: number) {
  const notes: string[] = [];

  if (window.endLine < window.startLine && window.startLine > 1)
    notes.push(
      `[offset ${window.startLine} is past the end of the file${totalLines === undefined ? "" : ` (${totalLines} lines)`}.]`,
    );

  if (window.lineCut)
    notes.push(
      `[Line ${window.startLine} exceeds 50 KiB and was cut; use a shell command such as cut or head -c to read the rest.]`,
    );

  if (window.nextOffset !== undefined)
    notes.push(
      `[Showing lines ${window.startLine}-${window.endLine}. Use offset=${window.nextOffset} to continue.]`,
    );

  if (!notes.length) return window.text;

  return `${window.text}${window.text.endsWith("\n") || !window.text ? "" : "\n"}\n${notes.join("\n")}`;
}
