import type { LinearActivityRecord, LinearCommentRecord, LinearIssueRecord, LinearSessionRecord } from "./world.ts";

/** One line of a transcript, in the shape every channel's transcript has (`api/common.d.ts`). */
export interface TranscriptEntry {
  id: string;
  author: { id: string; name: string; kind: "user" | "app" };
  at: string;
  text: string;
  controls: string[];
  edited: boolean;
  depth: number;
}

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
  const at = (ms: number) => new Date(ms).toISOString();
  const entries: TranscriptEntry[] = [];
  const push = (id: string, user: string, ms: number, text: string, edited: boolean, depth: number) =>
    entries.push({ id, author: options.principal(user), at: at(ms), text, controls: [], edited, depth });
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

  const activitiesOf = (session: LinearSessionRecord) => {
    const all = input.activities(session);
    // A prompt that came in as a comment is already in the thread as that comment.
    return all.filter(
      (activity, index) => !(activity.ephemeral && index < all.length - 1) && activity.sourceComment === null,
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
  // session gets its thread from its first answer, so what it did before reads just above that.
  const top: Array<{ at: number; line: () => void }> = [];
  const threaded = new Set<string>();
  for (const root of input.comments.filter((comment) => comment.parent === null)) {
    const session = input.sessions.find((candidate) => candidate.thread === root.id);
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

  const text = entries
    .map((entry) => `${"  ".repeat(entry.depth)}${entry.author.name}: ${entry.text}${entry.edited ? " (edited)" : ""}`)
    .join("\n");
  return { entries, text };
}
