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
  const sessionLines = (session: LinearSessionRecord, depth: number) => {
    for (const activity of activitiesOf(session))
      push(activity.id, activity.user, activity.createdAt, activityText(activity), false, depth);
  };

  const roots = input.comments.filter((comment) => comment.parent === null);
  const shown = new Set<string>();
  for (const root of roots) {
    push(root.id, root.user, root.createdAt, options.readable(root.body), root.editedAt !== null, 0);
    // Replies and the activities of a session on this thread, in the order they happened.
    const session = input.sessions.find((candidate) => candidate.comment === root.id);
    if (session) shown.add(session.id);
    const replies = input.comments
      .filter((comment) => comment.parent === root.id)
      .map((comment) => ({
        at: comment.createdAt,
        line: () =>
          push(
            comment.id,
            comment.user,
            comment.createdAt,
            options.readable(comment.body),
            comment.editedAt !== null,
            1,
          ),
      }));
    const lines = [
      ...replies,
      ...(session
        ? activitiesOf(session).map((activity) => ({
            at: activity.createdAt,
            line: () => push(activity.id, activity.user, activity.createdAt, activityText(activity), false, 1),
          }))
        : []),
    ];
    for (const { line } of lines.sort((a, b) => a.at - b.at)) line();
  }
  // Sessions without a thread (a delegation) read after the comments.
  for (const session of input.sessions) if (!shown.has(session.id)) sessionLines(session, 0);

  const text = entries
    .map((entry) => `${"  ".repeat(entry.depth)}${entry.author.name}: ${entry.text}${entry.edited ? " (edited)" : ""}`)
    .join("\n");
  return { entries, text };
}
