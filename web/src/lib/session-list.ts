type SessionRow = {
  id: string;
  updatedAt: number;
  archived?: boolean;
  running?: boolean;
  /** When the row was pinned; pinned rows are listed apart, in the order they were pinned. */
  pinnedAt?: number;
};

// Keep a useful short list even when all sessions are old.
export function sessionList<T extends SessionRow>(
  rows: readonly T[],
  selected: string,
  now: number,
) {
  const active = rows.filter((row) => !row.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const unpinned = active.filter((row) => !row.pinnedAt);

  const recent = unpinned.filter(
    (row, index) =>
      index < 5 ||
      now - row.updatedAt <= 7 * 24 * 60 * 60 * 1000 ||
      row.id === selected ||
      row.running,
  );

  return {
    active,
    /** Pinned rows stay visible however old they are; archived ones wait in Archived. */
    pinned: active
      .filter((row) => row.pinnedAt)
      .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) || a.id.localeCompare(b.id)),
    unpinned,
    recent,
    older: unpinned.length - recent.length,
    archived: rows.filter((row) => row.archived).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}
