import { ProtocolError } from "../errors/index.ts";
import { randomString } from "../secrets/index.ts";

/**
 * The live allowlists (implementation plan 12.2): live mode acts only in the workspaces, orgs,
 * teams and Notion workspaces listed in `CHANNELSTACK_LIVE_*`, so a token that leaks into a test
 * can't post into a company's real workspace.
 */
export class Allowlist {
  readonly #variable: string;
  readonly #ids: ReadonlySet<string>;

  /** `variable` names the environment variable: comma-separated ids. */
  constructor(variable: string, env: Readonly<Record<string, string | undefined>>) {
    this.#variable = variable;
    this.#ids = new Set(
      (env[variable] ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    );
  }

  get variable(): string {
    return this.#variable;
  }

  allows(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Refuse before anything is done there. `what` names the place for the message ("workspace T0…"). */
  assert(id: string, what: string): void {
    if (!this.allows(id)) {
      throw new ProtocolError(
        "live_not_allowlisted",
        `${what} isn't in ${this.#variable}, so live mode won't act there`,
        { id, allowlist: this.#variable },
      );
    }
  }
}

const RUN_TAG_PREFIX = "channelstack-run-";

/** The tag every live object a run creates carries in its name or description: `channelstack-run-<run>`. */
export function runTag(run: string): string {
  return `${RUN_TAG_PREFIX}${run}`;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Names for what a live world makes, unique in a real workspace: the run's tag, a mark of this
 * world's own, a number, and the test's name for it when it gave one
 * (`channelstack-run-<run>-<world>-<n>[-<name>]`). The mark keeps two processes of one run (the
 * live examples, then the differential run) apart: Slack keeps an archived channel's name, so a
 * second `-1` of the same run would be `name_taken`.
 */
export function taggedNames(tag: string): (name?: string) => string {
  const world = randomString(4, LETTERS);
  let count = 0;
  return (name) => [tag, world, String(++count), ...(name ? [name] : [])].join("-");
}

/** The run a tagged name belongs to, or nothing for a name channelstack didn't make. */
export function taggedRun(name: string): string | undefined {
  const at = name.indexOf(RUN_TAG_PREFIX);
  if (at === -1) return undefined;
  return /^[a-z0-9]+/.exec(name.slice(at + RUN_TAG_PREFIX.length))?.[0];
}

/**
 * A run id: 1 to 24 lowercase letters and digits, so it fits every platform's names, and never 7
 * digits in a row: Linear refuses a team name that looks like a phone number.
 */
export function isRunId(value: string): boolean {
  return /^[a-z0-9]{1,24}$/.test(value) && !/\d{7}/.test(value);
}

/**
 * A run id as given (`CHANNELSTACK_RUN_ID`, `sweep --run`), in the form live names take: lowercased,
 * and each run of 7 or more digits written in base 36 until none is left (`gh45602242231` →
 * `ghky6ebav`), the same way every time. A CI job's `gh${{ github.run_id }}` works as it is, and the
 * sweep finds a run by the id the job was given. Undefined when the result isn't a run id.
 */
export function normalizeRunId(value: string): string | undefined {
  let id = value.trim().toLowerCase();
  while (/\d{7}/.test(id)) id = id.replace(/\d{7,}/g, (digits) => BigInt(digits).toString(36));
  return isRunId(id) ? id : undefined;
}

/** The run id: from `CHANNELSTACK_RUN_ID` (CI sets it to the job's), else made up from the CSPRNG. */
export function runId(env: Readonly<Record<string, string | undefined>>): string {
  const given = env.CHANNELSTACK_RUN_ID?.trim();
  if (given) {
    const id = normalizeRunId(given);
    if (id === undefined) throw new Error(`CHANNELSTACK_RUN_ID must be 1-24 letters and digits, got "${given}"`);
    return id;
  }
  return randomString(10, LETTERS);
}
