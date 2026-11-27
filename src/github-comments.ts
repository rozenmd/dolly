/**
 * list_pull_request_comments' pages: a pull request's discussion comments, reviews and inline
 * threads, newest activity first, split into pages that each fit the tool output. Nothing is
 * truncated: an item too big for one page is split into numbered parts (a thread at comment
 * boundaries, a single huge body into pieces), so following next_page reaches every character.
 */

/**
 * Serialized bytes of items on one page. The tool output is capped at 51,200 bytes; this leaves
 * room for the page's envelope (cursor, counts, note).
 */
export const COMMENTS_PAGE_BYTES = 45_000;

/** How long a read's pages stay available to its cursor. */
export const COMMENTS_SNAPSHOT_MS = 10 * 60_000;

type Scalar = string | number | boolean | null;

/** What a page holds: plain JSON, measured as it will be sent. */
export type Json = Scalar | readonly Json[] | { readonly [key: string]: Json };

/** One comment or review body with its author. */
export type Post = {
  id: number;
  author: string | null;
  created_at: string | null;
  url: string | null;
  body: string;
  /**
   * Whether the author is this App, an installed GitHub App or an allowed sender, as the review
   * handoff decides; false marks untrusted text. Unset when no GitHub App is connected.
   */
  trusted?: boolean;
};

/** A discussion comment, a review (one post each) or an inline thread (its comments). */
export type CommentItem = {
  type: "comment" | "review" | "thread";
  id: number;
  /** Latest activity, an ISO timestamp ("" when GitHub sent none). */
  at: string;
  /** Fields every part of the item repeats: a review's state, a thread's path and resolved... */
  fields: { readonly [key: string]: Scalar };
  /** Oldest first. */
  posts: readonly Post[];
};

const encoder = new TextEncoder();
const jsonBytes = (value: Json) => encoder.encode(JSON.stringify(value)).length;

// Placeholders as wide as any real part number, so a piece measured with them still fits.
const WIDE = 999_999;

/** `text` in the fewest pieces that each satisfy `fits`, never splitting a code point. */
function splitText(text: string, fits: (piece: string) => boolean) {
  const points = Array.from(text);
  const pieces: string[] = [];
  let start = 0;

  while (start < points.length) {
    let low = start + 1;
    let high = points.length;

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);

      if (fits(points.slice(start, mid).join(""))) low = mid;
      else high = mid - 1;
    }

    pieces.push(points.slice(start, low).join(""));
    start = low;
  }

  return pieces.length ? pieces : [""];
}

const numbered = <T extends { readonly [key: string]: Json }>(parts: readonly T[]): Json[] =>
  parts.length === 1
    ? [...parts]
    : parts.map((part, index) => ({ ...part, part: index + 1, parts: parts.length }));

/** A comment or review as one or more parts, its body split only when it can't fit a page. */
function single(item: CommentItem, budget: number) {
  const post = item.posts[0]!;

  const render = (body: string) => ({
    type: item.type,
    id: item.id,
    ...item.fields,
    author: post.author,
    ...(post.trusted !== undefined && { trusted: post.trusted }),
    created_at: post.created_at,
    url: post.url,
    body,
  });

  if (jsonBytes(render(post.body)) <= budget) return [render(post.body)];

  return numbered(
    splitText(
      post.body,
      (piece) => jsonBytes({ ...render(piece), part: WIDE, parts: WIDE }) <= budget,
    ).map(render),
  );
}

/** A thread as one or more parts, split between comments (and inside a comment too big alone). */
function thread(item: CommentItem, budget: number) {
  const head = { type: item.type, id: item.id, ...item.fields };

  const fits = (comments: readonly Json[]) =>
    jsonBytes({ ...head, part: WIDE, parts: WIDE, comments }) <= budget;

  const units = item.posts.flatMap((post) => {
    if (fits([post])) return [post];

    const marked = (body: string) => ({ ...post, body, body_part: WIDE, body_parts: WIDE });
    const pieces = splitText(post.body, (piece) => fits([marked(piece)]));

    return pieces.map((body, index) => ({
      ...post,
      body,
      body_part: index + 1,
      body_parts: pieces.length,
    }));
  });

  const groups: Json[][] = [];

  for (const unit of units) {
    const current = groups.at(-1);

    if (current && fits([...current, unit])) current.push(unit);
    else groups.push([unit]);
  }

  return numbered(groups.map((comments) => ({ ...head, comments })));
}

/**
 * Pages of at most `budget` serialized bytes (array separators included), newest activity
 * first. An item's parts stay together and in order.
 */
export function commentPages(items: readonly CommentItem[], budget = COMMENTS_PAGE_BYTES) {
  const parts = [...items]
    .sort((a, b) => (a.at === b.at ? b.id - a.id : a.at < b.at ? 1 : -1))
    .flatMap((item) =>
      item.type === "thread" ? thread(item, budget - 1) : single(item, budget - 1),
    );

  const pages: Json[][] = [];
  let size = 0;

  for (const part of parts) {
    const bytes = jsonBytes(part) + 1;
    const current = pages.at(-1);

    if (current && size + bytes <= budget) {
      current.push(part);
      size += bytes;
    } else {
      pages.push([part]);
      size = bytes;
    }
  }

  return pages;
}
