import { describe, expect, test } from "vitest";

import { ProtocolError } from "../errors/index.ts";
import { Allowlist, isRunId, normalizeRunId, runId, runTag, taggedNames, taggedRun } from "./index.ts";

describe("safety", () => {
  test("an allowlist holds the ids its variable lists, and refuses the rest", () => {
    const list = new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", { CHANNELSTACK_LIVE_SLACK_TEAMS: " T1, T2 ,," });
    expect(list.allows("T1")).toBe(true);
    expect(list.allows("T2")).toBe(true);
    expect(list.allows("T3")).toBe(false);
    expect(new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", {}).allows("")).toBe(false);
    try {
      list.assert("T3", "Slack workspace T3");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect(error).toMatchObject({ code: "live_not_allowlisted", status: 403 });
      expect((error as Error).message).toBe(
        "Slack workspace T3 isn't in CHANNELSTACK_LIVE_SLACK_TEAMS, so live mode won't act there",
      );
    }
  });

  test("the run tag goes into names, and comes back out of them", () => {
    expect(runTag("gh123")).toBe("channelstack-run-gh123");
    expect(taggedRun("channelstack-run-gh123-4-support")).toBe("gh123");
    expect(taggedRun("support")).toBeUndefined();
  });

  test("a run id is short lowercase letters and digits: from CHANNELSTACK_RUN_ID, or made up", () => {
    expect(runId({ CHANNELSTACK_RUN_ID: "GH123" })).toBe("gh123");
    expect(() => runId({ CHANNELSTACK_RUN_ID: "gh-123" })).toThrow(/1-24 letters and digits/);
    const made = runId({});
    expect(isRunId(made)).toBe(true);
    expect(runId({})).not.toBe(made);
    expect(isRunId("a".repeat(25))).toBe(false);
    // A CI job's id: Linear refused a team named with its 11 digits as a phone number. The same id
    // always gives the same tag, so the sweep finds the run by what the job was given.
    expect(isRunId("gh45602242231")).toBe(false);
    expect(runId({ CHANNELSTACK_RUN_ID: "gh45602242231" })).toBe("ghky6ebav");
    expect(normalizeRunId("GH45602242231")).toBe("ghky6ebav");
    expect(normalizeRunId("gh123456")).toBe("gh123456");
    // Base 36 can still have 7 digits in a row: written again until none are left.
    expect(normalizeRunId("x2821109907456")).toMatch(/^x[a-z0-9]+$/);
    expect(isRunId(normalizeRunId("x2821109907456") ?? "")).toBe(true);
    expect(normalizeRunId("gh-1")).toBeUndefined();
  });

  test("two worlds of one run never make the same name", () => {
    const [first, second] = [taggedNames(runTag("gh1")), taggedNames(runTag("gh1"))];
    const [a, b] = [first(), second()];
    expect(a).toMatch(/^channelstack-run-gh1-[a-z]{4}-1$/);
    expect(a).not.toBe(b);
    expect(first("support")).toMatch(/^channelstack-run-gh1-[a-z]{4}-2-support$/);
    expect([a, b].map(taggedRun)).toEqual(["gh1", "gh1"]);
  });
});
