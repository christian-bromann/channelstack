import { createHash } from "node:crypto";

import { uniformInt } from "pure-rand/distribution/uniformInt";
import { xoroshiro128plus } from "pure-rand/generator/xoroshiro128plus";
import type { RandomGenerator } from "pure-rand/types/RandomGenerator";

import type { Clock } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import type { Draw, IdFormat } from "./formats.ts";

export {
  CHANNELSTACK_IDS,
  DIGITS,
  type Draw,
  HEX,
  type IdFormat,
  idFormats,
  type IdShape,
  LOWER_ALNUM,
  numeric,
  UPPER_ALNUM,
  uuid,
} from "./formats.ts";

/** A seed from `CHANNELSTACK_SEED`: a number as is, any other text hashed to 32 bits. */
export function parseSeed(seed: string): number {
  if (/^\d{1,9}$/.test(seed)) return Number(seed);
  return createHash("sha256").update(seed).digest().readUInt32BE(0);
}

/**
 * The one source of ids. Random ids come from a seeded generator, so a run with the same
 * `CHANNELSTACK_SEED` hands out the same ids; they never repeat within a world.
 */
export class IdGenerator {
  readonly #rng: RandomGenerator;
  readonly #clock: Clock;
  readonly #used = new Map<string, Set<string>>();
  readonly #sequences = new Map<string, number>();
  #lastTs = 0;
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
  next(format: IdFormat): string {
    const used = this.#usedSet(format.kind);
    for (;;) {
      const id = format.generate(this.#draw);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  }

  /** Claim an id the test chose (`createUser({ id })`). It must look like the platform's ids and be free. */
  reserve(format: IdFormat, id: string): string {
    const { kind } = format;
    if (!(format.accepts ?? format.pattern).test(id)) {
      throw new ProtocolError("invalid_argument", `"${id}" is not a valid ${kind} id`, { kind, id });
    }
    const used = this.#usedSet(kind);
    if (used.has(id))
      throw new ProtocolError("invalid_argument", `The ${kind} id "${id}" is already in use`, { kind, id });
    used.add(id);
    return id;
  }

  /** Give a reserved id back when the session that held it closes, so a later test can claim it again. */
  release(format: IdFormat, id: string): void {
    this.#used.get(format.kind)?.delete(id);
  }

  /** The next number in a sequence, starting at 1: GitHub issue numbers per repo, Linear issue numbers per team. */
  sequence(scope: string): number {
    const next = (this.#sequences.get(scope) ?? 0) + 1;
    this.#sequences.set(scope, next);
    return next;
  }

  /**
   * Microseconds since the epoch, strictly increasing across the world, with a random part below
   * the millisecond: what a Slack `ts` is made of.
   */
  monotonicMicros(): number {
    const now = this.#clock();
    const candidate = Math.floor(now / 1000) * 1_000_000 + (now % 1000) * 1000 + this.#draw.int(0, 999);
    const micros = Math.max(candidate, this.#lastTs + 1);
    this.#lastTs = micros;
    return micros;
  }

  /** Start sequences and `ts` over for a new world (`POST /reset`). Ids already handed out stay taken, so none repeats. */
  reset(): void {
    this.#sequences.clear();
    this.#lastTs = 0;
  }

  #usedSet(kind: string): Set<string> {
    let used = this.#used.get(kind);
    if (!used) {
      used = new Set();
      this.#used.set(kind, used);
    }
    return used;
  }
}
