import { richTextPieces } from "../../core/rich-text/index.ts";

/**
 * `RichText` → Slack mrkdwn: `@name` becomes a real mention (`<@U…>`) of the person or app with
 * that name, and `@@` is a literal `@`. A name nobody has is left as it was typed.
 */
export function resolveMentions(text: string, lookup: (name: string) => string | undefined): string {
  return richTextPieces(text, lookup)
    .map((piece) => ("text" in piece ? piece.text : `<@${piece.mention}>`))
    .join("");
}

/** A mention in Slack mrkdwn: `<@U…>`, or `<@U…|label>`. */
const MENTION = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;

/** The user ids mentioned in Slack mrkdwn. */
export function mentionedUsers(text: string): string[] {
  return [...text.matchAll(MENTION)].map((match) => match[1] as string);
}

/**
 * Slack mrkdwn → what a person reads: every mention as `@name`. A mention of someone nobody
 * knows (an id the model made up) shows its label if it has one, else the id, as Slack does.
 */
export function nameMentions(text: string, nameOf: (userId: string) => string | undefined): string {
  return text.replace(MENTION, (_, id: string, label: string | undefined) => `@${nameOf(id) ?? (label || id)}`);
}

/** A link in Slack mrkdwn, `<https://…>` or `<https://…|label>`: not a mention, channel or special (`<@`, `<#`, `<!`). */
const LINK = /<([^@#!>|][^>|]*)(?:\|([^>]*))?>/g;

/**
 * Slack mrkdwn → the text a person typed in Slack's client: Slack wraps what it reads as a link
 * (`<https://…>`, `<https://…|label>`) and escapes `&`, `<` and `>`. Mentions stay as they are.
 */
export function typedText(text: string): string {
  return unescapeMrkdwn(text.replace(LINK, (_, url: string, label: string | undefined) => label ?? url));
}

/** Slack mrkdwn's escapes undone: `&lt;`, `&gt;` and `&amp;` are `<`, `>` and `&`. */
export const unescapeMrkdwn = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** An emoji's name as Slack stores it: `:eyes:` and `eyes` are the same reaction. */
export const emojiName = (emoji: string): string => emoji.replace(/^:|:$/g, "");
