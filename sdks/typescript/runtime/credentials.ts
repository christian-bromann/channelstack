/** A name as it appears in an environment variable: `Ana` → `ANA`, `ana-smith` → `ANA_SMITH`. */
function envName(value: unknown): string {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

/**
 * A credential from the environment, when a test leaves it out: `CHANNELSTACK_SLACK_USER_{name}_TOKEN`
 * with `{ name: "Ana" }` reads `CHANNELSTACK_SLACK_USER_ANA_TOKEN`. Unset (or empty), it is
 * `undefined`, and the object is fake. So one test runs fake on every PR and live where the
 * variables are set (live-mode.md, section 4).
 */
export function credential(template: string, values: Readonly<Record<string, unknown>>): string | undefined {
  const missing = [...template.matchAll(/\{(\w+)\}/g)].some((match) => values[match[1] as string] === undefined);
  if (missing) return undefined;
  const variable = template.replace(/\{(\w+)\}/g, (_, field: string) => envName(values[field]));
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  return env[variable] || undefined;
}
