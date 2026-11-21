const UNITS: ReadonlyArray<readonly [string, number]> = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];

export function formatRelativeTime(timestamp: string | number | undefined, now = Date.now()): string | undefined {
  if (timestamp === undefined) return undefined;
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(value)) return undefined;
  const elapsed = Math.max(0, now - value);
  for (const [label, size] of UNITS) {
    if (elapsed >= size) return `${Math.floor(elapsed / size)}${label} ago`;
  }
  return "just now";
}
