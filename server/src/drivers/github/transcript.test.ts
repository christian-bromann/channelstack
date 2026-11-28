import { describe, expect, test } from "vitest";

import { githubTime } from "./payloads.ts";
import { renderTranscript } from "./transcript.ts";
import type { GitHubCommentRecord, GitHubIssueRecord } from "./world.ts";

describe("the transcript of an issue", () => {
  test("each entry's time is its own, to the millisecond, though GitHub's API writes it to the second", () => {
    const opened = Date.parse("2026-11-27T10:00:05.123Z");
    const commented = opened + 400;
    const issue: GitHubIssueRecord = {
      id: 1,
      repo: 1,
      number: 1,
      title: "Login fails",
      body: null,
      author: 7,
      state: "open",
      stateReason: null,
      labels: ["bug"],
      assignees: [],
      reactions: [],
      createdAt: opened,
      // Labelled later in the same second: the issue changed, its first entry didn't.
      updatedAt: commented + 300,
      closedAt: undefined,
      closedBy: undefined,
      pull: undefined,
    };
    const comment: GitHubCommentRecord = {
      id: 2,
      repo: 1,
      issue: 1,
      author: 7,
      body: "still broken",
      reactions: [],
      minimized: undefined,
      createdAt: commented,
      updatedAt: commented,
      delivery: undefined,
    };
    const { entries } = renderTranscript({ issue, comments: [comment], reviews: [], reviewComments: [] }, () => ({
      id: "7",
      name: "ana",
      kind: "user",
    }));
    expect(entries.map((entry) => entry.at)).toEqual(["2026-11-27T10:00:05.123Z", "2026-11-27T10:00:05.523Z"]);
    expect(githubTime(commented)).toBe("2026-11-27T10:00:05Z");
  });
});
