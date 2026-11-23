import { type TranscriptEntry, transcriptText } from "../../core/router/inspect.ts";
import { githubTime } from "./payloads.ts";
import type { GitHubCommentRecord, GitHubIssueRecord, GitHubReviewCommentRecord, GitHubReviewRecord } from "./world.ts";

const REVIEW_VERDICT: Readonly<Record<string, string>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "reviewed",
  DISMISSED: "review dismissed",
};

/**
 * An issue or a pull request reduced to what a person reads on its page: the description, the
 * comments, the reviews with their verdict, and the threads on the diff under the comment that
 * started them. A comment someone hid shows as hidden, as on GitHub.
 */
export function renderTranscript(
  thread: {
    issue?: GitHubIssueRecord;
    comments: readonly GitHubCommentRecord[];
    reviews: readonly GitHubReviewRecord[];
    reviewComments: readonly GitHubReviewCommentRecord[];
  },
  principal: (user: number) => TranscriptEntry["author"],
): { entries: TranscriptEntry[]; text: string } {
  const timed: Array<{ at: number; entries: TranscriptEntry[] }> = [];
  const entry = (
    id: number,
    author: number,
    at: number,
    text: string,
    edited: boolean,
    depth: number,
  ): TranscriptEntry => ({
    id: String(id),
    author: principal(author),
    at: githubTime(at),
    text,
    controls: [],
    edited,
    depth,
  });
  const { issue } = thread;
  if (issue) {
    const text = issue.body === null ? issue.title : `${issue.title}\n${issue.body}`;
    timed.push({ at: issue.createdAt, entries: [entry(issue.id, issue.author, issue.createdAt, text, false, 0)] });
  }
  for (const comment of thread.comments) {
    const text = comment.minimized ? `(hidden as ${comment.minimized.toLowerCase().replace("_", "-")})` : comment.body;
    timed.push({
      at: comment.createdAt,
      entries: [entry(comment.id, comment.author, comment.createdAt, text, comment.updatedAt > comment.createdAt, 0)],
    });
  }
  // A thread reads as its first comment (with where it is), then the rest indented under it. When
  // the comment that started it was deleted, the oldest one left takes its place.
  const threads = new Map<number, GitHubReviewCommentRecord[]>();
  for (const comment of thread.reviewComments)
    threads.set(comment.thread, [...(threads.get(comment.thread) ?? []), comment]);
  const heads = [...threads.values()].flatMap(([head]) => head ?? []);
  const inThread = (head: GitHubReviewCommentRecord) =>
    (threads.get(head.thread) ?? []).map((comment) =>
      entry(
        comment.id,
        comment.author,
        comment.createdAt,
        comment === head ? `${comment.path}:${comment.line}: ${comment.body}` : comment.body,
        comment.updatedAt > comment.createdAt,
        comment === head ? 0 : 1,
      ),
    );
  for (const review of thread.reviews) {
    if (review.state === "PENDING") continue;
    const at = review.submittedAt ?? 0;
    // A review with nothing but comments on the diff reads as those comments; a verdict or a body is a line of its own.
    const headline =
      review.state !== "COMMENTED" || review.body !== ""
        ? [
            entry(
              review.id,
              review.author,
              at,
              [REVIEW_VERDICT[review.state], review.body].filter(Boolean).join(": "),
              false,
              0,
            ),
          ]
        : [];
    timed.push({ at, entries: [...headline, ...heads.filter((head) => head.review === review.id).flatMap(inThread)] });
  }
  // A thread whose review isn't listed (the transcript of one thread) still shows.
  const listed = new Set(thread.reviews.map((review) => review.id));
  for (const head of heads) if (!listed.has(head.review)) timed.push({ at: head.createdAt, entries: inThread(head) });
  const entries = timed.sort((a, b) => a.at - b.at).flatMap((group) => group.entries);
  return { entries, text: transcriptText(entries) };
}
