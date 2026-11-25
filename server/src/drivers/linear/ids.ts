import { HEX, idFormats, type IdGenerator, UPPER_ALNUM, uuid } from "../../core/ids/index.ts";

/**
 * Every id the Linear fake generates, in the platform's own format (architecture.md 3.2).
 */
export const LINEAR_IDS = idFormats("linear", {
  uuid: uuid,
  // The short id in an agent session's URL (`/agent-session/<slugId>`).
  slugId: { pattern: /^[0-9a-f]{12}$/, generate: (draw) => draw.chars(12, HEX) },
  // A team key a test didn't choose: a letter, then capitals and digits, like the keys people pick.
  teamKey: {
    pattern: /^T[0-9A-Z]{5}$/,
    accepts: /^[A-Z][A-Z0-9]{0,6}$/,
    generate: (draw) => `T${draw.chars(5, UPPER_ALNUM)}`,
  },
});

/** A Linear issue identifier, counted per team: `ENG-1`, `ENG-2`, … */
export function linearIdentifier(ids: IdGenerator, teamKey: string): string {
  return `${teamKey}-${ids.sequence(`linear.identifier:${teamKey}`)}`;
}
