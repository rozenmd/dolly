/** Compact elapsed time: 45s, 2m, 3h, 4d. */
export function ago(at: number, now = Date.now()) {
  return duration(Math.max(0, now - at));
}

export function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
