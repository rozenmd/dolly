/** Line-level change counts, as shown beside an edit in the transcript (`+added -removed`). */
export type DiffStats = { readonly added: number; readonly removed: number };

export type Edit = {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
};

/** Files the edit tools will load whole to apply a change and count its lines. */
export const MAX_EDIT_BYTES = 8 * 1024 * 1024;

// Bounds the O((N+M)·D) line diff on large, heavily rewritten files.
const DIFF_WORK = 20_000_000;

/** Lines with their terminators, so a changed final newline counts as a changed line (like git). */
function lines(text: string) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Myers' shortest edit distance between two line ranges. Returns every line as
 * changed when the ranges are too different to compare within the work budget.
 */
function editDistance(before: readonly string[], after: readonly string[], start: number) {
  const n = before.length - start;
  const m = after.length - start;
  const max = n + m;

  if (n === 0 || m === 0) return max;

  const limit = Math.min(max, Math.max(1, Math.floor(DIFF_WORK / max)));
  const offset = limit + 1;
  const furthest = new Int32Array(2 * limit + 3);

  for (let distance = 0; distance <= limit; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down =
        diagonal === -distance ||
        (diagonal !== distance &&
          furthest[offset + diagonal - 1] < furthest[offset + diagonal + 1]);

      let x = down ? furthest[offset + diagonal + 1] : furthest[offset + diagonal - 1] + 1;
      let y = x - diagonal;

      while (x < n && y < m && before[start + x] === after[start + y]) {
        x++;
        y++;
      }

      furthest[offset + diagonal] = x;

      if (x >= n && y >= m) return distance;
    }
  }

  return max;
}

/** Lines added and removed between two versions of a file. */
export function diffStats(before: string, after: string): DiffStats {
  const old = lines(before);
  const next = lines(after);
  let prefix = 0;

  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;

  let oldEnd = old.length;
  let nextEnd = next.length;

  while (oldEnd > prefix && nextEnd > prefix && old[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd--;
    nextEnd--;
  }

  const removedSpan = oldEnd - prefix;
  const addedSpan = nextEnd - prefix;
  const distance = editDistance(old.slice(0, oldEnd), next.slice(0, nextEnd), prefix);

  // Every edit is one added or one removed line, so the distance splits by the size change.
  return {
    added: (distance + addedSpan - removedSpan) / 2,
    removed: (distance - addedSpan + removedSpan) / 2,
  };
}

function occurrences(text: string, search: string) {
  let count = 0;

  for (
    let index = text.indexOf(search);
    index >= 0;
    index = text.indexOf(search, index + search.length)
  )
    count++;

  return count;
}

/** Apply an exact-string replacement, or explain why it cannot be applied unambiguously. */
export function applyEdit(
  text: string,
  path: string,
  edit: Edit,
): { ok: true; text: string; replacements: number } | { ok: false; message: string } {
  if (edit.old_string === edit.new_string)
    return { ok: false, message: "old_string and new_string are identical; nothing to change" };

  const count = occurrences(text, edit.old_string);

  if (count === 0)
    return {
      ok: false,
      message: `old_string was not found in ${path}. Read the file and copy the exact text, including whitespace and indentation.`,
    };

  if (count > 1 && !edit.replace_all)
    return {
      ok: false,
      message: `old_string matches ${count} places in ${path}. Include more surrounding lines to make it unique, or set replace_all to change every match.`,
    };

  if (edit.replace_all)
    return {
      ok: true,
      text: text.split(edit.old_string).join(edit.new_string),
      replacements: count,
    };

  const index = text.indexOf(edit.old_string);

  return {
    ok: true,
    text: text.slice(0, index) + edit.new_string + text.slice(index + edit.old_string.length),
    replacements: 1,
  };
}
