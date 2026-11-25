import { idFormats, LOWER_ALNUM, numeric, UPPER_ALNUM, uuid } from "../../core/ids/index.ts";

/**
 * Every id the GitHub fake generates, in the platform's own format (architecture.md 3.2).
 */
export const GITHUB_IDS = idFormats("github", {
  user: numeric(100_000_000, 299_999_999, /^[12]\d{8}$/),
  repo: numeric(1_000_000_000, 1_199_999_999, /^1[01]\d{8}$/),
  app: numeric(1_000_000, 2_999_999, /^[12]\d{6}$/),
  installation: numeric(60_000_000, 99_999_999, /^[6-9]\d{7}$/),
  issue: numeric(3_000_000_000, 3_999_999_999, /^3\d{9}$/),
  comment: numeric(3_000_000_000, 3_999_999_999, /^3\d{9}$/),
  review: numeric(3_000_000_000, 3_999_999_999, /^3\d{9}$/),
  checkRun: numeric(50_000_000_000, 59_999_999_999, /^5\d{10}$/),
  // An App's client id, as GitHub issues them now.
  clientId: {
    pattern: /^Iv23li[A-Za-z0-9]{14}$/,
    generate: (draw) => `Iv23li${draw.chars(14, `${UPPER_ALNUM}${LOWER_ALNUM.slice(10)}`)}`,
  },
  delivery: uuid,
  // The id of a delivery in the App's delivery log (`/app/hook/deliveries`).
  hookDelivery: numeric(20_000_000_000, 29_999_999_999, /^2\d{10}$/),
  label: numeric(7_000_000_000, 7_999_999_999, /^7\d{9}$/),
  reaction: numeric(200_000_000, 299_999_999, /^2\d{8}$/),
  status: numeric(30_000_000_000, 39_999_999_999, /^3\d{10}$/),
  pull: numeric(2_000_000_000, 2_999_999_999, /^2\d{9}$/),
});

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
