/**
 * How the broken-agent test runs one check: `CHANNELSTACK_CHECKS_ONLY=<id>` skips every other id
 * of the list. Without the variable nothing is skipped.
 */
export function onlyFromEnv(ids: readonly string[]): { skip?: string[] } {
  const only = process.env.CHANNELSTACK_CHECKS_ONLY;
  return only ? { skip: ids.filter((id) => id !== only) } : {};
}
