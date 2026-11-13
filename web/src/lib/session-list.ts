type SessionRow = {
  id: string;
  updatedAt: number;
  archived?: boolean;
  running?: boolean;
};

// Keep a useful short list even when all sessions are old.
export function sessionList<T extends SessionRow>(
  rows: readonly T[],
  selected: string,
  now: number,
) {
  const active = rows.filter((row) => !row.archived).sort((a, b) => b.updatedAt - a.updatedAt);

  const recent = active.filter(
    (row, index) =>
      index < 5 ||
      now - row.updatedAt <= 7 * 24 * 60 * 60 * 1000 ||
      row.id === selected ||
      row.running,
  );

  return {
    active,
    recent,
    older: active.length - recent.length,
    archived: rows.filter((row) => row.archived).sort((a, b) => b.updatedAt - a.updatedAt),
  };
}
