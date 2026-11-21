/** A duration: milliseconds as a number, or `"250ms"`, `"3s"`, `"1m"`. */
export type Duration = number | `${number}ms` | `${number}s` | `${number}m`;

const UNITS = { ms: 1, s: 1000, m: 60_000 } as const;

/** A duration in milliseconds. */
export function parseDuration(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) throw new TypeError(`Not a duration: ${duration}`);
    return duration;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(duration);
  if (!match) throw new TypeError(`Not a duration: "${duration}". Use milliseconds, or "250ms", "3s", "1m".`);
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
}
