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

/**
 * Stamped by the host on every automatic review's body. GitHub also files each thread reply as a
 * bodiless review on the head it was made at, so only this marks Dolly's actual review of a head.
 */
export const AUTOMATIC_REVIEW_MARKER = "<!-- dolly:automatic-review -->";

/**
 * Footer earlier versions appended to every review body and comment. Nothing posts it any more; it
 * is only recognized on reviews posted before the stamp.
 */
const LEGACY_REVIEW_FOOTER = "<sub>— posted by Dolly</sub>";

/**
 * Whether a review body (of this App's, on the head) is its automatic review: stamped, or, for
 * reviews posted before the stamp, carrying the footer earlier versions ended every body with. The
 * bodiless records GitHub files for thread replies match neither.
 */
export const isAutomaticReview = (body: string | null | undefined) =>
  body?.includes(AUTOMATIC_REVIEW_MARKER) === true || body?.includes(LEGACY_REVIEW_FOOTER) === true;

/**
 * `body` with the automatic-review stamp added, cut to fit `limit` so a body the tool accepted
 * stays valid once stamped.
 */
export function stampAutomaticReview(body: string, limit: number) {
  const stamp = `\n\n${AUTOMATIC_REVIEW_MARKER}`;

  return `${body.slice(0, Math.max(0, limit - stamp.length))}${stamp}`;
}

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
