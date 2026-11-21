import { createHash } from "node:crypto";
import { uniformInt } from "pure-rand/distribution/uniformInt";
import { xoroshiro128plus } from "pure-rand/generator/xoroshiro128plus";
import type { RandomGenerator } from "pure-rand/types/RandomGenerator";
import type { Clock } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import { type Draw, ID_FORMATS, type IdKind } from "./formats.ts";

export { ID_FORMATS, type IdKind, SLACK_TS_PATTERN } from "./formats.ts";

/** A seed from `CHANNELSTACK_SEED`: a number as is, any other text hashed to 32 bits. */
export function parseSeed(seed: string): number {
  if (/^\d{1,9}$/.test(seed)) return Number(seed);
  return createHash("sha256").update(seed).digest().readUInt32BE(0);
}

const NODE_ID_PREFIX = {
  User: "U",
  Bot: "BOT",
  Repository: "R",
  Issue: "I",
  PullRequest: "PR",
  IssueComment: "IC",
} as const;

/**
 * A GitHub GraphQL node id, built the way GitHub builds them: a type prefix, then base64url of
 * msgpack `[0, ...databaseIds]`. A user is `U_kgDO…`; an issue (repo id, issue id) is `I_kwDO…`.
 */
export function githubNodeId(type: keyof typeof NODE_ID_PREFIX, databaseIds: readonly number[]): string {
  const bytes = Buffer.alloc(2 + databaseIds.length * 5);
  bytes[0] = 0x90 | (databaseIds.length + 1);
  bytes[1] = 0x00;
  databaseIds.forEach((id, i) => {
    bytes[2 + i * 5] = 0xce;
    bytes.writeUInt32BE(id, 3 + i * 5);
  });
  return `${NODE_ID_PREFIX[type]}_${bytes.toString("base64url")}`;
}

/**
 * The one source of ids. Random ids come from a seeded generator, so a run with the same
 * `CHANNELSTACK_SEED` hands out the same ids; they never repeat within a world.
 */
export class IdGenerator {
  readonly #rng: RandomGenerator;
  readonly #clock: Clock;
  readonly #used = new Map<IdKind, Set<string>>();
  readonly #sequences = new Map<string, number>();
  readonly #lastTs = new Map<string, number>();
  readonly #draw: Draw;

  constructor(options: { seed: number; clock: Clock }) {
    this.#rng = xoroshiro128plus(options.seed);
    this.#clock = options.clock;
    this.#draw = {
      int: (min, max) => uniformInt(this.#rng, min, max),
      chars: (length, alphabet) => {
        let out = "";
        for (let i = 0; i < length; i++) out += alphabet[uniformInt(this.#rng, 0, alphabet.length - 1)];
        return out;
      },
    };
  }

  /** A new id of this kind, unique in the world. */
  next(kind: IdKind): string {
    const used = this.#usedSet(kind);
    for (;;) {
      const id = ID_FORMATS[kind].generate(this.#draw);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  }

  /** Claim an id the test chose (`createUser({ id })`). It must look like the platform's ids and be free. */
  reserve(kind: IdKind, id: string): string {
    const format: { pattern: RegExp; accepts?: RegExp } = ID_FORMATS[kind];
    if (!(format.accepts ?? format.pattern).test(id)) {
      throw new ProtocolError("invalid_argument", `"${id}" is not a valid ${kind} id`, { kind, id });
    }
    const used = this.#usedSet(kind);
    if (used.has(id))
      throw new ProtocolError("invalid_argument", `The ${kind} id "${id}" is already in use`, { kind, id });
    used.add(id);
    return id;
  }

  /** The next number in a sequence, starting at 1: GitHub issue numbers per repo, Linear issue numbers per team. */
  sequence(scope: string): number {
    const next = (this.#sequences.get(scope) ?? 0) + 1;
    this.#sequences.set(scope, next);
    return next;
  }

  /** A Linear issue identifier, counted per team: `ENG-1`, `ENG-2`, … */
  linearIdentifier(teamKey: string): string {
    return `${teamKey}-${this.sequence(`linear.identifier:${teamKey}`)}`;
  }

  /** A Slack message `ts`: epoch seconds and microseconds, strictly increasing per conversation. */
  slackTs(conversation: string): string {
    const now = this.#clock();
    const candidate = Math.floor(now / 1000) * 1_000_000 + (now % 1000) * 1000 + this.#draw.int(0, 999);
    const micros = Math.max(candidate, (this.#lastTs.get(conversation) ?? 0) + 1);
    this.#lastTs.set(conversation, micros);
    return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
  }

  /** Forget which ids are taken (`POST /reset`). The random sequence continues, so ids still don't repeat. */
  reset(): void {
    this.#sequences.clear();
    this.#lastTs.clear();
  }

  #usedSet(kind: IdKind): Set<string> {
    let used = this.#used.get(kind);
    if (!used) {
      used = new Set();
      this.#used.set(kind, used);
    }
    return used;
  }
}
