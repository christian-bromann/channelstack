import type { Awaitable } from "../../core/router/index.ts";
import type { NotionStore } from "./fake/store.ts";
import type { PageInput } from "./fake/world.ts";
import type { NotionLinks } from "./links.ts";
import type { NotionObjects } from "./objects.ts";
import type { NotionReads, TextPattern } from "./reads.ts";
import type { RichTextItem } from "./rich-text.ts";
import type { NotionCommentRecord, NotionDiscussionRecord, NotionPageRecord, NotionUserRecord } from "./world.ts";

/**
 * What people do in Notion, written once. The fake implements it over its store; the live world
 * against real Notion, keeping what it read and made in a store of its own, so the routes read
 * records the same way from both (architecture.md 3.3). A delivery comes back only from the fake:
 * live, Notion delivers to the agent itself.
 */
export interface NotionWorld extends NotionReads {
  /** The records the routes read: the fake's own, or the live world's mirror of real Notion. */
  readonly store: NotionStore;
  readonly links: NotionLinks;
  readonly objects: NotionObjects;

  createUser(
    session: string,
    input: {
      name: string;
      id?: string | undefined;
      email?: string | undefined;
      avatarUrl?: string | undefined;
      token?: string | undefined;
    },
  ): Awaitable<NotionUserRecord>;
  createPage(
    session: string,
    input: PageInput,
    options: { announce: boolean },
  ): Awaitable<{ page: NotionPageRecord; delivery: string | undefined }>;
  edit(
    session: string,
    page: NotionPageRecord,
    change: { append?: string | unknown[] | undefined; replace?: string | unknown[] | undefined },
    actor: string,
  ): Awaitable<void>;
  rename(session: string, page: NotionPageRecord, title: string, actor: string): Awaitable<string | undefined>;
  /** A person mentions an integration in the page body: the built-in one unless another's bot is named. */
  mention(
    session: string,
    page: NotionPageRecord,
    inBlock: TextPattern | undefined,
    actor: string,
    integration?: string,
  ): Awaitable<void>;
  comment(
    session: string,
    page: NotionPageRecord,
    rich: RichTextItem[],
    actor: string,
    anchor?: TextPattern,
  ): Awaitable<NotionCommentRecord>;
  reply(
    session: string,
    discussion: NotionDiscussionRecord,
    rich: RichTextItem[],
    actor: string,
  ): Awaitable<NotionCommentRecord>;
  editComment(
    session: string,
    comment: NotionCommentRecord,
    rich: RichTextItem[],
    actor: string,
  ): Awaitable<string | undefined>;
  deleteComment(session: string, comment: NotionCommentRecord, actor: string): Awaitable<string | undefined>;
  /**
   * Read again what a read is about: a page with its blocks and discussions, or a discussion's
   * page. The fake holds the truth already; live, this asks Notion.
   */
  refresh(session: string, about: { page: string } | { discussion: string }): Awaitable<void>;
}
