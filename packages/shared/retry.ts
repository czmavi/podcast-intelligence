export function exponentialBackoffMs(attempt: number, baseMs = 1000, maxMs = 300_000): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
