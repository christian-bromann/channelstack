import { describe, expect, test } from "vitest";

import { IdGenerator } from "../core/ids/index.ts";
import { GITHUB_IDS, githubLegacyNodeId, githubNodeId } from "./github/ids.ts";
import { DRIVERS } from "./index.ts";
import { linearIdentifier } from "./linear/ids.ts";
import { SLACK_TS_PATTERN, slackTs } from "./slack/ids.ts";

const COUNT = 10_000;
const fixedClock = () => 1_732_101_234_567;
const generator = (seed = 42) => new IdGenerator({ seed, clock: fixedClock });
const formats = DRIVERS.flatMap((driver) => Object.values(driver.ids));

describe("exit check 0.5: ids look real", () => {
  test("every driver names its formats after itself, and no two share a kind", () => {
    for (const driver of DRIVERS) {
      for (const format of Object.values(driver.ids)) expect(format.kind.startsWith(`${driver.name}.`)).toBe(true);
    }
    expect(new Set(formats.map((format) => format.kind)).size).toBe(formats.length);
  });

  test.each(formats.map((format) => [format.kind, format] as const))(
    "10,000 %s ids match the format and never collide",
    (_kind, format) => {
      const ids = generator();
      const seen = new Set<string>();
      for (let i = 0; i < COUNT; i++) {
        const id = ids.next(format);
        expect(id).toMatch(format.pattern);
        seen.add(id);
      }
      expect(seen.size).toBe(COUNT);
    },
  );

  test("10,000 Slack ts values match the format and increase strictly per conversation", () => {
    const ids = generator();
    let last = "";
    for (let i = 0; i < COUNT; i++) {
      const ts = slackTs(ids);
      expect(ts).toMatch(SLACK_TS_PATTERN);
      expect(ts > last).toBe(true);
      last = ts;
    }
    expect(last.startsWith("1732101234.") || last.startsWith("1732101235.")).toBe(true);
  });

  test("Linear identifiers count per team", () => {
    const ids = generator();
    const identifiers = Array.from({ length: COUNT }, () => linearIdentifier(ids, "ENG"));
    expect(identifiers[0]).toBe("ENG-1");
    expect(identifiers.at(-1)).toBe(`ENG-${COUNT}`);
    expect(new Set(identifiers).size).toBe(COUNT);
    expect(linearIdentifier(ids, "OPS")).toBe("OPS-1");
  });

  test("GitHub node ids are built like GitHub's", () => {
    const ids = generator();
    for (let i = 0; i < COUNT; i++) {
      const user = Number(ids.next(GITHUB_IDS.user));
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

  test("what git identifies has the repository's id and the SHA or ref name in its node id", () => {
    /** Decode `[0, <repo id>, <text>]` back out of a node id. */
    const decode = (node: string) => {
      const bytes = Buffer.from(node.slice(node.indexOf("_") + 1), "base64url");
      const head = bytes[7] ?? 0;
      const [at, length] =
        head === 0xda ? [10, bytes.readUInt16BE(8)] : head === 0xd9 ? [9, bytes[8] ?? 0] : [8, head & 0x1f];
      return [
        bytes[0],
        bytes[1],
        bytes[2],
        bytes.readUInt32BE(3),
        bytes.subarray(at, at + length).toString(),
        bytes.length - at - length,
      ];
    };
    const sha = "9cfb61596ada71b173edf3a415802f8bbc35c1ef";
    expect(githubNodeId("Commit", [1_000_000_123, sha])).toMatch(/^C_kwDO/);
    expect(decode(githubNodeId("Commit", [1_000_000_123, sha]))).toEqual([0x93, 0x00, 0xce, 1_000_000_123, sha, 0]);
    expect(decode(githubNodeId("Blob", [7, sha]))).toEqual([0x93, 0x00, 0xce, 7, sha, 0]);
    // A short name, one of 32 bytes or more, and one longer than 255 each have their own header.
    for (const name of ["refs/heads/main", `refs/heads/${"a".repeat(40)}`, `refs/heads/${"b".repeat(300)}`]) {
      const node = githubNodeId("Ref", [7, name]);
      expect(node).toMatch(/^REF_/);
      expect(decode(node)).toEqual([0x93, 0x00, 0xce, 7, name, 0]);
    }
    expect(() => githubNodeId("Ref", [7, "x".repeat(70_000)])).toThrow(/that long/);
    for (const [type, prefix] of [
      ["Reaction", "REA_"],
      ["App", "A_"],
      ["StatusContext", "SC_"],
      ["PullRequestReviewThread", "PRRT_"],
    ] as const) {
      expect(githubNodeId(type, [1])).toMatch(new RegExp(`^${prefix}kgDO`));
    }
    expect(githubLegacyNodeId("IntegrationInstallation", 12345)).toBe("MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uMTIzNDU=");
  });
});
