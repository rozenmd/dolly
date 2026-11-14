/** Lines a review comment may target in one file's unified diff patch, per side. */
export function commentableLines(patch: string) {
  const left = new Set<number>();
  const right = new Set<number>();
  let old = 0;
  let next = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      continue;
    }

    if (!inHunk || line.startsWith("\\")) continue;

    if (line.startsWith("+")) right.add(next++);
    else if (line.startsWith("-")) left.add(old++);
    else {
      left.add(old++);
      right.add(next++);
    }
  }

  return { LEFT: left, RIGHT: right };
}

type Anchor = {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly start_line?: number;
  readonly start_side?: "LEFT" | "RIGHT";
};

/**
 * Explains why each comment cannot anchor to the diff, instead of GitHub's opaque 422.
 * `patches` maps changed paths to their patch, or undefined when GitHub omitted it.
 */
export function invalidAnchors(
  comments: readonly Anchor[],
  patches: ReadonlyMap<string, string | undefined>,
) {
  const problems: string[] = [];

  comments.forEach((comment, index) => {
    const where = `comment ${index} (${comment.path}:${comment.line} ${comment.side})`;

    if (!patches.has(comment.path)) {
      problems.push(`${where}: file is not changed in this pull request`);

      return;
    }

    const patch = patches.get(comment.path);

    if (patch === undefined) {
      problems.push(`${where}: GitHub has no text diff for this file (binary or too large)`);

      return;
    }

    const lines = commentableLines(patch);

    if (!lines[comment.side].has(comment.line))
      problems.push(`${where}: line is outside the diff hunks on the ${comment.side} side`);

    if (comment.start_line !== undefined) {
      const side = comment.start_side ?? comment.side;

      if (!lines[side].has(comment.start_line))
        problems.push(`${where}: start_line ${comment.start_line} is outside the diff on ${side}`);
      else if (side === comment.side && comment.start_line >= comment.line)
        problems.push(`${where}: start_line must be before line`);
    }
  });

  return problems;
}

export const REVIEW_FOOTER = "\n\n<sub>— posted by Dolly</sub>";

/** Keeps the agent's output bounded: patches past the budget are dropped and flagged. */
export function budgetPatches<F extends { readonly patch?: string }>(
  files: readonly F[],
  budget: number,
) {
  let used = 0;

  return files.map((file) => {
    const size = file.patch?.length ?? 0;

    if (used + size <= budget) {
      used += size;

      return { ...file, patch_truncated: false };
    }

    return { ...file, patch: undefined, patch_truncated: file.patch !== undefined };
  });
}
