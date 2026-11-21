/**
 * `RichText` → Slack mrkdwn: `@name` becomes a real mention (`<@U…>`) of the person or app with
 * that name, and `@@` is a literal `@`. A name nobody has is left as it was typed.
 */
export function resolveMentions(text: string, lookup: (name: string) => string | undefined): string {
  return text.replace(/@@|@([A-Za-z0-9][A-Za-z0-9._-]*)/g, (match, name: string | undefined) => {
    if (name === undefined) return "@";
    // A sentence may end right after the name: "@my-agent." mentions "my-agent".
    for (let end = name.length; end > 0; end--) {
      const id = lookup(name.slice(0, end));
      if (id !== undefined && !/[A-Za-z0-9]/.test(name.slice(end, end + 1))) return `<@${id}>${name.slice(end)}`;
    }
    return match;
  });
}

/** A mention in Slack mrkdwn: `<@U…>`, or `<@U…|label>`. */
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** The user ids mentioned in Slack mrkdwn. */
export function mentionedUsers(text: string): string[] {
  return [...text.matchAll(MENTION)].map((match) => match[1] as string);
}

/** Slack mrkdwn → what a person reads: every mention as `@name`. */
export function nameMentions(text: string, nameOf: (userId: string) => string): string {
  return text.replace(MENTION, (_, id: string) => `@${nameOf(id)}`);
}

/** Text split at its mentions: each piece is plain text, or the id of the user one mention names. */
export function splitAtMentions(text: string): Array<{ text: string } | { user: string }> {
  const pieces: Array<{ text: string } | { user: string }> = [];
  let from = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > from) pieces.push({ text: text.slice(from, match.index) });
    pieces.push({ user: match[1] as string });
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from) });
  return pieces;
}

/** An emoji's name as Slack stores it: `:eyes:` and `eyes` are the same reaction. */
export const emojiName = (emoji: string): string => emoji.replace(/^:|:$/g, "");
