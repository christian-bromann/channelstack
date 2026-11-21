import { describe, expect, test } from "vitest";

import { ProtocolError } from "../errors/index.ts";
import { githubNodeId, ID_FORMATS, IdGenerator, type IdKind, parseSeed, SLACK_TS_PATTERN } from "./index.ts";

const COUNT = 10_000;
const kinds = Object.keys(ID_FORMATS) as IdKind[];
const fixedClock = () => 1_732_101_234_567;
const generator = (seed = 42) => new IdGenerator({ seed, clock: fixedClock });

describe("exit check 0.5: ids look real", () => {
  test.each(kinds)("10,000 %s ids match the format and never collide", (kind) => {
    const ids = generator();
    const seen = new Set<string>();
    for (let i = 0; i < COUNT; i++) {
      const id = ids.next(kind);
      expect(id).toMatch(ID_FORMATS[kind].pattern);
      seen.add(id);
    }
    expect(seen.size).toBe(COUNT);
  });

  test("10,000 Slack ts values match the format and increase strictly per conversation", () => {
    const ids = generator();
    let last = "";
    for (let i = 0; i < COUNT; i++) {
      const ts = ids.slackTs("C08E1F2G3H4");
      expect(ts).toMatch(SLACK_TS_PATTERN);
      expect(ts > last).toBe(true);
      last = ts;
    }
    expect(last.startsWith("1732101234.") || last.startsWith("1732101235.")).toBe(true);
  });

  test("sequential ids count per scope, like GitHub issue numbers and Linear identifiers", () => {
    const ids = generator();
    expect([ids.sequence("github.issue:1"), ids.sequence("github.issue:1"), ids.sequence("github.issue:2")]).toEqual([
      1, 2, 1,
    ]);
    const identifiers = Array.from({ length: COUNT }, () => ids.linearIdentifier("ENG"));
    expect(identifiers[0]).toBe("ENG-1");
    expect(identifiers.at(-1)).toBe(`ENG-${COUNT}`);
    expect(new Set(identifiers).size).toBe(COUNT);
    expect(ids.linearIdentifier("OPS")).toBe("OPS-1");
  });

  test("GitHub node ids are built like GitHub's", () => {
    const ids = generator();
    for (let i = 0; i < COUNT; i++) {
      const user = Number(ids.next("github.user"));
      expect(githubNodeId("User", [user])).toMatch(/^U_kgDO[A-Za-z0-9_-]{6}$/);
    }
    // 583231 is octocat's database id; MDQ6… ids predate this format, so check the encoding by decoding.
    const node = githubNodeId("Issue", [1_000_000_123, 3_000_000_456]);
    expect(node).toMatch(/^I_kwDO[A-Za-z0-9_-]{12}$/);
    const bytes = Buffer.from(node.slice(2), "base64url");
    expect([bytes[0], bytes[1], bytes[2], bytes.readUInt32BE(3), bytes[7], bytes.readUInt32BE(8)]).toEqual([
      0x93, 0x00, 0xce, 1_000_000_123, 0xce, 3_000_000_456,
    ]);
    expect(githubNodeId("PullRequest", [1, 2])).toMatch(/^PR_kwDO/);
    expect(githubNodeId("Repository", [1])).toMatch(/^R_kgDO/);
  });

  test("the same seed gives the same ids, a different seed doesn't", () => {
    const draw = (seed: number) => {
      const ids = generator(seed);
      return [...kinds.map((kind) => ids.next(kind)), ids.slackTs("C1"), ids.slackTs("C1")];
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  test("CHANNELSTACK_SEED accepts a number or any text", () => {
    expect(parseSeed("42")).toBe(42);
    expect(parseSeed("release-candidate")).toBe(parseSeed("release-candidate"));
    expect(parseSeed("a")).not.toBe(parseSeed("b"));
    expect(Number.isInteger(parseSeed("1234567890123"))).toBe(true);
  });
});

describe("fixed ids", () => {
  test("an id in the platform's format is accepted once", () => {
    const ids = generator();
    expect(ids.reserve("slack.user", "U0ADMIN01")).toBe("U0ADMIN01");
    expect(() => ids.reserve("slack.user", "U0ADMIN01")).toThrow(/already in use/);
  });

  test("an id in the wrong format is refused with invalid_argument", () => {
    const ids = generator();
    for (const [kind, id] of [
      ["slack.user", "ana"],
      ["slack.user", "C08E1F2G3H4"],
      ["github.user", "-1"],
      ["linear.uuid", "not-a-uuid"],
    ] as const) {
      expect(() => ids.reserve(kind, id)).toThrow(ProtocolError);
    }
  });

  test("a generated id never reuses a reserved one, and reset starts sequences over", () => {
    const ids = generator();
    const twin = generator();
    const taken = twin.next("slack.user");
    ids.reserve("slack.user", taken);
    expect(ids.next("slack.user")).not.toBe(taken);

    ids.sequence("s");
    ids.reset();
    expect(ids.sequence("s")).toBe(1);
  });
});
