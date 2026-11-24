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

/**
 * Names for what a live world makes, unique in a real workspace: the run's tag, a number of the
 * world's own, and the test's name for it when it gave one (`channelstack-run-<run>-<n>[-<name>]`).
 */
export function taggedNames(tag: string): (name?: string) => string {
  let count = 0;
  return (name) => [tag, String(++count), ...(name ? [name] : [])].join("-");
}

/** The run a tagged name belongs to, or nothing for a name channelstack didn't make. */
export function taggedRun(name: string): string | undefined {
  const at = name.indexOf(RUN_TAG_PREFIX);
  if (at === -1) return undefined;
  return /^[a-z0-9]+/.exec(name.slice(at + RUN_TAG_PREFIX.length))?.[0];
}

/** A run id: 1 to 24 lowercase letters and digits, so it fits every platform's names. */
export function isRunId(value: string): boolean {
  return /^[a-z0-9]{1,24}$/.test(value);
}

/** The run id: from `CHANNELSTACK_RUN_ID` (CI sets it to the job's), else made up from the CSPRNG. */
export function runId(env: Readonly<Record<string, string | undefined>>): string {
  const given = env.CHANNELSTACK_RUN_ID?.trim().toLowerCase();
  if (given) {
    if (!isRunId(given)) throw new Error(`CHANNELSTACK_RUN_ID must be 1-24 letters and digits, got "${given}"`);
    return given;
  }
  return randomString(10, "abcdefghijklmnopqrstuvwxyz0123456789");
}
