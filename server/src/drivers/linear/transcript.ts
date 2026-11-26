import { iso } from "../../core/clock/index.ts";
import { type TranscriptEntry, transcriptText } from "../../core/router/inspect.ts";
import type { LinearActivityRecord, LinearCommentRecord, LinearIssueRecord, LinearSessionRecord } from "./world.ts";

/** What an activity reads as: its body, or for an action what it did and to what. */
function activityText(activity: LinearActivityRecord): string {
  const { content } = activity;
  if (content.type === "action") {
    const result = content.result ? ` → ${content.result}` : "";
    return `${content.action} ${content.parameter ?? ""}${result}`.trim();
  }
  const label = content.type === "response" || content.type === "prompt" ? "" : `(${content.type}) `;
  return `${label}${content.body ?? ""}`;
}

/**
 * An issue reduced to what a person reads on its page: the description, the comments with their
 * replies, and each agent session's activities under its thread. An ephemeral activity is gone
 * once a later one replaced it, as in Linear.
 */
export function renderTranscript(
  input: {
    issue?: LinearIssueRecord;
    comments: readonly LinearCommentRecord[];
    sessions: readonly LinearSessionRecord[];
    activities: (session: LinearSessionRecord) => readonly LinearActivityRecord[];
  },
  options: {
    principal(userId: string): TranscriptEntry["author"];
    readable(markdown: string): string;
  },
): { entries: TranscriptEntry[]; text: string } {
  const entries: TranscriptEntry[] = [];
  const push = (id: string, user: string, ms: number, text: string, edited: boolean, depth: number) =>
    entries.push({ id, author: options.principal(user), at: iso(ms), text, controls: [], edited, depth });
  const { issue } = input;
  if (issue)
    push(
      issue.id,
      issue.creator,
      issue.createdAt,
      issue.description ? `${issue.title}\n${issue.description}` : issue.title,
      false,
      0,
    );

  // Linear's own comment, which opens a delegated session's thread: no one wrote it.
  const byLinear = new Set(input.comments.filter((comment) => comment.byLinear).map((comment) => comment.id));
  const activitiesOf = (session: LinearSessionRecord) => {
    const all = input.activities(session);
    // What came in as a comment, or went out as one, is already in the thread as that comment.
    return all.filter(
      (activity, index) =>
        !(activity.ephemeral && index < all.length - 1) &&
        (activity.sourceComment === null || byLinear.has(activity.sourceComment)),
    );
  };
  const activityLine = (activity: LinearActivityRecord, depth: number) => ({
    at: activity.createdAt,
    line: () => push(activity.id, activity.user, activity.createdAt, activityText(activity), false, depth),
  });
  const commentLine = (comment: LinearCommentRecord, depth: number) => ({
    at: comment.createdAt,
    line: () =>
      push(
        comment.id,
        comment.user,
        comment.createdAt,
        options.readable(comment.body),
        comment.editedAt !== null,
        depth,
      ),
  });
  const inOrder = (lines: Array<{ at: number; line: () => void }>) => {
    for (const { line } of lines.sort((a, b) => a.at - b.at)) line();
  };

  // The page reads in time order: top-level comments, and the activities of sessions without a
  // thread. Under each comment: its replies, and the activities of the session on it. A delegated
  // session's thread is Linear's, so what is in it reads as the page's own lines.
  const top: Array<{ at: number; line: () => void }> = [];
  const threaded = new Set<string>();
  for (const root of input.comments.filter((comment) => comment.parent === null)) {
    const session = input.sessions.find((candidate) => candidate.thread === root.id);
    if (root.byLinear) {
      // In the session's order: each turn as its comment where it is one, else as the activity
      // (a comment and the activity it is can share a millisecond with the turn before).
      const replies = input.comments.filter((comment) => comment.parent === root.id);
      const placed = new Set<string>();
      if (session) {
        threaded.add(session.id);
        const shown = new Set(activitiesOf(session));
        for (const activity of input.activities(session)) {
          const reply = replies.find((comment) => comment.id === activity.sourceComment);
          if (reply) placed.add(reply.id);
          if (reply) top.push({ at: activity.createdAt, line: commentLine(reply, 0).line });
          else if (shown.has(activity)) top.push(activityLine(activity, 0));
        }
      }
      top.push(...replies.filter((reply) => !placed.has(reply.id)).map((reply) => commentLine(reply, 0)));
      continue;
    }
    const all = session ? input.activities(session) : [];
    const opened = all.findIndex((activity) => activity.sourceComment === root.id);
    const shown = session ? activitiesOf(session) : [];
    const before = shown.filter((activity) => all.indexOf(activity) < opened);
    const after = shown.filter((activity) => all.indexOf(activity) > opened);
    if (session) threaded.add(session.id);
    const replies = input.comments
      .filter((comment) => comment.parent === root.id)
      .map((reply) => commentLine(reply, 1));
    const thread = [...replies, ...after.map((activity) => activityLine(activity, 1))];
    top.push({
      at: root.createdAt,
      line: () => {
        for (const activity of before) activityLine(activity, 0).line();
        commentLine(root, 0).line();
        inOrder(thread);
      },
    });
  }
  for (const session of input.sessions)
    if (!threaded.has(session.id)) for (const activity of activitiesOf(session)) top.push(activityLine(activity, 0));
  inOrder(top);

  return { entries, text: transcriptText(entries) };
}
