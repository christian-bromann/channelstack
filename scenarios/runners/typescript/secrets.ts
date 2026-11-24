/**
 * Fields a fixture hands the agent (`privateKey`, `webhookSecret`, `botToken`): the one rule for
 * what no recording, comparison or result file holds. The scenario runner leaves them out as it
 * records (`--record`), and the differential run's `normalize` again. It has no imports, so the
 * packaging check can copy it next to the runner.
 */
export const SECRET_FIELD = /token|secret|privatekey|password/i;
