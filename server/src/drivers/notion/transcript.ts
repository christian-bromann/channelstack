import type { FakeNotionWorld } from "./fake/world.ts";
import { plainText } from "./rich-text.ts";
import type { NotionDiscussionRecord, NotionPageRecord } from "./world.ts";

type Principal = { id: string; name: string; kind: "user" | "app" };

/** One line of a transcript, in the shape every channel's transcript has (`api/common.d.ts`). */
interface TranscriptEntry {
  id: string;
  author: Principal;
  at: string;
  text: string;
  controls: string[];
  edited: boolean;
  depth: number;
}

const toText = (entries: TranscriptEntry[]) =>
  entries
    .map((entry) => `${"  ".repeat(entry.depth)}${entry.author.name}: ${entry.text}${entry.edited ? " (edited)" : ""}`)
    .join("\n");

const commentLines = (
  world: FakeNotionWorld,
  discussion: NotionDiscussionRecord,
  principal: (id: string) => Principal,
  depth: number,
): TranscriptEntry[] =>
  world.commentsOf(discussion).map((comment) => ({
    id: comment.id,
    author: principal(comment.createdBy),
    at: new Date(comment.createdAt).toISOString(),
    text: plainText(comment.rich),
    controls: [],
    edited: comment.lastEditedAt !== comment.createdAt,
    depth,
  }));

/** A discussion as a person reads it: its comments, oldest first. */
export function renderDiscussion(
  world: FakeNotionWorld,
  discussion: NotionDiscussionRecord,
  principal: (id: string) => Principal,
) {
  const entries = commentLines(world, discussion, principal, 0);
  return { entries, text: toText(entries) };
}

/**
 * A page as a person reads it: who made it and its title, its body as Markdown, then each
 * discussion, a block's under a line naming what it is anchored to.
 */
export function renderPage(world: FakeNotionWorld, page: NotionPageRecord, principal: (id: string) => Principal) {
  const entries: TranscriptEntry[] = [];
  const body = world.markdownOf(page);
  entries.push({
    id: page.id,
    author: principal(page.createdBy),
    at: new Date(page.createdAt).toISOString(),
    text: body === "" ? world.titleOf(page) : `${world.titleOf(page)}\n${body}`,
    controls: [],
    edited: false,
    depth: 0,
  });
  for (const discussion of world.discussionsOf(page)) {
    const lines = commentLines(world, discussion, principal, discussion.anchor === null ? 0 : 1);
    if (discussion.anchor !== null && lines[0])
      lines[0] = { ...lines[0], depth: 0, text: `(on "${discussion.anchor}") ${lines[0].text}` };
    entries.push(...lines);
  }
  return { entries, text: toText(entries) };
}
