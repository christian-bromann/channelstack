import { ProtocolError } from "../../core/errors/index.ts";
import { richTextPieces } from "../../core/rich-text/index.ts";
import type { NotionStore } from "./fake/store.ts";
import { blockToMarkdown } from "./markdown.ts";
import { plainText, type RichTextItem, textItem, userMention } from "./rich-text.ts";
import type { NotionBlockRecord, NotionDiscussionRecord, NotionPageRecord } from "./world.ts";

/** Text to find in a page: a string it contains, or a pattern. */
export type TextPattern = string | { source: string; flags: string };

/**
 * Reading a Notion workspace's records, written once for both worlds: the fake's own store, and
 * the live world's mirror of real Notion, which keeps the same record shapes (architecture.md 3.3).
 */
export function notionReads(
  store: NotionStore,
  /** The people a session can name: its own, as the fake keeps them; live, the shared pool's it holds too. */
  peopleOf: (session: string) => ReadonlyArray<{ id: string; name: string }> = (session) => store.users.list(session),
) {
  /** A page's title: its title property, whatever the database calls it. */
  const titleOf = (page: NotionPageRecord): string => {
    const title = Object.values(page.properties).find((value) => value.type === "title");
    return title?.type === "title" ? plainText(title.rich) : "";
  };

  const isBot = (id: string) => id === store.bot.id;

  /** Is the integration connected to this page or database, itself or through a parent? */
  const accessible = (id: string): boolean => {
    const page = store.pages.find(id);
    const database = page ? undefined : store.databases.find(id);
    const record = page ?? database;
    if (!record || record.inTrash) return false;
    if (record.connections.includes(store.bot.id)) return true;
    return record.parent.type === "workspace" ? false : accessible(record.parent.id);
  };

  const childrenOf = (ids: readonly string[]) => ids.map((id) => store.block(id)).filter((block) => !block.inTrash);

  /** Every block on a page, depth first. */
  const allBlocks = (page: NotionPageRecord): NotionBlockRecord[] => {
    const walk = (ids: readonly string[]): NotionBlockRecord[] =>
      childrenOf(ids).flatMap((block) => [block, ...walk(block.children)]);
    return walk(page.children);
  };

  const blockText = (block: NotionBlockRecord) => plainText((block.data.rich_text as RichTextItem[] | undefined) ?? []);

  /** A block's object as it is now: a `child_page` carries its page's current title. */
  const dataOf = (block: NotionBlockRecord): Record<string, unknown> =>
    block.type === "child_page" ? { title: titleOf(store.page(block.id)) } : block.data;

  const markdownOf = (page: NotionPageRecord): string => {
    const render = (ids: readonly string[]): string[] =>
      childrenOf(ids).map((block) => blockToMarkdown(block.type, dataOf(block), render(block.children)));
    return render(page.children).join("\n");
  };

  /** `RichText` (`"@my-agent summarize"`) → Notion rich text, with mentions of people and the bot. */
  const richText = (session: string, text: string): RichTextItem[] =>
    richTextPieces(text, (name) => {
      if (name.toLowerCase() === store.bot.name.toLowerCase()) return store.bot.id;
      return peopleOf(session).find((user) => user.name.toLowerCase() === name.toLowerCase())?.id;
    }).map((piece) =>
      "text" in piece
        ? textItem(piece.text)
        : userMention(piece.mention, store.user(piece.mention)?.name ?? piece.name, isBot(piece.mention)),
    );

  /** The block of a page whose text has this in it: where a comment is anchored, or a mention goes. */
  const blockWith = (page: NotionPageRecord, text: TextPattern): NotionBlockRecord => {
    let has: (block: string) => boolean;
    if (typeof text === "string") has = (block) => block.includes(text);
    else {
      let pattern: RegExp;
      try {
        // `g` and `y` make a pattern remember where it stopped; finding a block needs neither.
        pattern = new RegExp(text.source, text.flags.replace(/[gy]/g, ""));
      } catch {
        throw new ProtocolError("invalid_argument", `/${text.source}/${text.flags} is not a pattern`);
      }
      has = (block) => pattern.test(block);
    }
    const found = allBlocks(page).find((block) => has(blockText(block)));
    const named = typeof text === "string" ? `"${text}"` : `/${text.source}/${text.flags}`;
    if (!found) throw new ProtocolError("not_found", `"${titleOf(page)}" has no block with ${named} in it`);
    return found;
  };

  return {
    titleOf,
    isBot,
    accessible,
    childrenOf,
    allBlocks,
    blockText,
    dataOf,
    markdownOf,
    richText,
    blockWith,
    discussionsOf: (page: NotionPageRecord) => store.discussionsOn(page.id),
    commentsOf: (discussion: NotionDiscussionRecord) => store.commentsIn(discussion.id),
  };
}

export type NotionReads = ReturnType<typeof notionReads>;
