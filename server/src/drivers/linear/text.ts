import { richTextPieces } from "../../core/rich-text/index.ts";
import type { LinearStore } from "./fake/store.ts";
import type { LinearLinks } from "./links.ts";
import type { LinearCommentRecord, LinearIssueRecord, LinearStateRecord, LinearUserRecord } from "./world.ts";

/**
 * What both worlds read the same way, from the records they hold (the fake's store, or the live
 * world's mirror of real Linear): text with mentions, a comment's thread, an issue's state.
 */
export function linearText(
  store: LinearStore,
  links: LinearLinks,
  /** Who `@name` in a test's text is, in a session: a person's or the app's user id. */
  resolve: (session: string, name: string) => string | undefined,
) {
  const userOf = (id: string): LinearUserRecord => {
    const user = store.user(id);
    if (!user) throw new Error(`No Linear user ${id}`);
    return user;
  };
  return {
    userOf,

    /** `RichText` → Linear Markdown: a mention of a person or the app is the link to their profile. */
    markdown: (session: string, text: string): string =>
      richTextPieces(text, (name) => resolve(session, name))
        .map((piece) => ("text" in piece ? piece.text : links.profile(userOf(piece.mention))))
        .join(""),

    /** The people and apps a Markdown text mentions. */
    mentioned: (body: string): string[] => {
      const handles = [...body.matchAll(links.profilePattern())].map((match) => match[1]);
      const everyone = [store.appUser, ...store.all(store.users)];
      return everyone.filter((user) => handles.includes(user.displayName)).map((user) => user.id);
    },

    /** Linear Markdown → what a person reads: a profile link is `@name` again. */
    readable: (body: string): string => body.replace(links.profilePattern(), (_, handle: string) => `@${handle}`),

    /** The thread a comment is in: its root comment. */
    rootOf: (comment: LinearCommentRecord): LinearCommentRecord =>
      comment.parent ? (store.comments.find(comment.parent) ?? comment) : comment,

    stateOf: (issue: LinearIssueRecord): LinearStateRecord => {
      const state = store.team(issue.team).states.find((candidate) => candidate.id === issue.state);
      if (!state) throw new Error(`Issue ${issue.identifier} is in no state of its team`);
      return state;
    },
  };
}
