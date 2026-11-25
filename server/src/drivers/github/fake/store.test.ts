import { describe, expect, test } from "vitest";

import { Registry } from "../../../core/registry/index.ts";
import type { GitHubReviewCommentRecord } from "../world.ts";
import { GitHubStore } from "./store.ts";

/** A comment on the diff in a thread; only what the store looks at is real. */
const inThread = (id: number, thread: number): GitHubReviewCommentRecord =>
  ({ id, thread, repo: 1, pull: 1 }) as GitHubReviewCommentRecord;

describe("the GitHub fake's store", () => {
  test("a resolved thread is forgotten with its last comment, not before (#16)", () => {
    const store = new GitHubStore(new Registry());
    const [first, reply, other] = [inThread(10, 10), inThread(11, 10), inThread(20, 20)];
    for (const comment of [first, reply, other]) store.add(store.reviewComments, "ses_a", comment);
    store.resolvedThreads.add(10);
    store.resolvedThreads.add(20);

    // The thread keeps its name when the comment that started it is deleted, and stays resolved.
    store.forgetReviewComment("ses_a", first);
    expect([...store.resolvedThreads].sort()).toEqual([10, 20]);
    store.forgetReviewComment("ses_a", reply);
    expect([...store.resolvedThreads]).toEqual([20]);
  });
});
