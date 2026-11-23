import { createHash } from "node:crypto";

import { uniformInt } from "pure-rand/distribution/uniformInt";
import { xoroshiro128plus } from "pure-rand/generator/xoroshiro128plus";
import type { RandomGenerator } from "pure-rand/types/RandomGenerator";

import type { Clock } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import { type Draw, ID_FORMATS, type IdKind } from "./formats.ts";

export { ID_FORMATS, type IdKind, SLACK_TS_PATTERN } from "./formats.ts";

/** When a Slack `ts` was issued, as an ISO time: a `ts` is seconds since the epoch, then a counter. */
export function slackTsTime(ts: string): string {
  return new Date(Number(ts.split(".")[0]) * 1000).toISOString();
}

/** A seed from `CHANNELSTACK_SEED`: a number as is, any other text hashed to 32 bits. */
export function parseSeed(seed: string): number {
  if (/^\d{1,9}$/.test(seed)) return Number(seed);
  return createHash("sha256").update(seed).digest().readUInt32BE(0);
}

const NODE_ID_PREFIX = {
  User: "U",
  Bot: "BOT",
  Organization: "O",
  App: "A",
  Repository: "R",
  Issue: "I",
  PullRequest: "PR",
  IssueComment: "IC",
  PullRequestReview: "PRR",
  PullRequestReviewComment: "PRRC",
  PullRequestReviewThread: "PRRT",
  Reaction: "REA",
  CheckRun: "CR",
  CheckSuite: "CS",
  StatusContext: "SC",
  Label: "LA",
  Commit: "C",
  Blob: "B",
  Ref: "REF",
} as const;

/** One msgpack value: an unsigned integer (32 bits where it fits, 64 for the larger ids), or a short string. */
function msgpack(value: number | string): Buffer {
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    // msgpack's three string headers: up to 31 bytes, up to 255, up to 65,535.
    if (text.length > 0xffff) throw new Error("A node id can't hold a string that long");
    const head =
      text.length < 32
        ? [0xa0 | text.length]
        : text.length < 256
          ? [0xd9, text.length]
          : [0xda, text.length >> 8, text.length & 0xff];
    return Buffer.concat([Buffer.from(head), text]);
  }
  const wide = value > 0xffff_ffff;
  const bytes = Buffer.alloc(wide ? 9 : 5);
  bytes[0] = wide ? 0xcf : 0xce;
  if (wide) bytes.writeBigUInt64BE(BigInt(value), 1);
  else bytes.writeUInt32BE(value, 1);
  return bytes;
}

/**
 * A GitHub GraphQL node id, built the way GitHub builds them: a type prefix, then base64url of
 * msgpack `[0, ...parts]`. A user is `U_kgDO…`; an issue (repo id, issue id) is `I_kwDO…`; what
 * git identifies (a commit, a blob, a ref) is the repository's id and the SHA or the ref's name.
 */
export function githubNodeId(type: keyof typeof NODE_ID_PREFIX, parts: ReadonlyArray<number | string>): string {
  const head = Buffer.from([0x90 | (parts.length + 1), 0x00]);
  return `${NODE_ID_PREFIX[type]}_${Buffer.concat([head, ...parts.map(msgpack)]).toString("base64url")}`;
}

/**
 * A node id of GitHub's older form, which some objects still carry: base64 of `0<n>:<Type><id>`,
 * where `<n>` is the length of the type's name. An App's installation in a webhook has one.
 */
export function githubLegacyNodeId(type: string, id: number): string {
  return Buffer.from(`0${type.length}:${type}${id}`).toString("base64");
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

  /** Give a reserved id back when the session that held it closes, so a later test can claim it again. */
  release(kind: IdKind, id: string): void {
    this.#used.get(kind)?.delete(id);
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

  /**
   * A Slack message `ts`: epoch seconds and microseconds. Strictly increasing across the world, so
   * a `ts` is unique in its conversation and orders messages the way they were written.
   */
  slackTs(): string {
    const now = this.#clock();
    const candidate = Math.floor(now / 1000) * 1_000_000 + (now % 1000) * 1000 + this.#draw.int(0, 999);
    const micros = Math.max(candidate, this.#lastTs + 1);
    this.#lastTs = micros;
    return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
  }

  /** Start sequences and `ts` over for a new world (`POST /reset`). Ids already handed out stay taken, so none repeats. */
  reset(): void {
    this.#sequences.clear();
    this.#lastTs = 0;
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
