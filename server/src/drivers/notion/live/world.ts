import type { Clock } from "../../../core/clock/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { IdGenerator } from "../../../core/ids/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import {
  actionRequires,
  checkOnce,
  fakeActorInLiveWorld,
  liveMisconfigured,
  personWithoutToken,
  unsupportedInLive,
} from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import { taggedNames } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { NotionWorld } from "../backend.ts";
import { NotionStore } from "../fake/store.ts";
import type { PageInput } from "../fake/world.ts";
import { NOTION_IDS } from "../ids.ts";
import { notionLinks } from "../links.ts";
import { type BlockDraft, markdownToBlocks } from "../markdown.ts";
import { notionObjects } from "../objects.ts";
import { notionReads } from "../reads.ts";
import { type RichTextItem, textItem, userMention } from "../rich-text.ts";
import type {
  NotionBlockRecord,
  NotionCommentRecord,
  NotionDiscussionRecord,
  NotionPageRecord,
  NotionUserRecord,
} from "../world.ts";
import { NotionRefusal, type NotionRestClient, passing } from "./client.ts";
import { checkNotionCredential, identifyNotion } from "./identity.ts";

/** Real Notion's web app: where its links point. */
const NOTION_WEB = "https://www.notion.so";
/** How long a page read from Notion is used again before it is read anew. */
const READ_CACHE_MS = 1_000;
/** Who holds the integration's page in the mirror: no test session, so none can name it. */
const INTEGRATION_PAGE = "channelstack:integration-page";
/** Who seed data is by in the mirror when nobody is: no Notion id is all zeros. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

interface WireUser {
  id: string;
}
interface WirePage {
  id: string;
  parent: { type: string; page_id?: string; database_id?: string; data_source_id?: string };
  properties: Record<string, { type: string; title?: RichTextItem[] }>;
  icon: { type: string; emoji?: string } | null;
  created_by: WireUser;
  last_edited_by: WireUser;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  archived?: boolean;
}
interface WireBlock {
  id: string;
  type: string;
  parent: { type: string; page_id?: string; block_id?: string };
  has_children: boolean;
  created_by: WireUser;
  last_edited_by: WireUser;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  archived?: boolean;
  [type: string]: unknown;
}
interface WireComment {
  id: string;
  discussion_id: string;
  parent: { type: string; page_id?: string; block_id?: string };
  rich_text: RichTextItem[];
  created_by: WireUser;
  created_time: string;
  last_edited_time: string;
}

export interface LiveNotionWorld extends NotionWorld {
  ready(): Promise<void>;
  release(session: string): void;
  /** The credential of whoever the ledger names (`app`, `user:ANA`), while their session is open. */
  credential(owner: string, session: string): LiveCredential | undefined;
}

/** A rich text item as the API takes it in a request: the text and its marks, or whom it mentions. */
const requestRich = (item: RichTextItem): Record<string, unknown> =>
  item.type === "mention" && item.mention.type === "user"
    ? { type: "mention", mention: { user: { id: item.mention.user.id } } }
    : item.type === "text"
      ? { type: "text", text: item.text, annotations: item.annotations }
      : { type: "text", text: { content: item.plain_text } };

/** A block as the API takes it: its type's object, with nested blocks under it. */
const requestBlock = (draft: BlockDraft): Record<string, unknown> => {
  const data: Record<string, unknown> = { ...draft.data };
  if (Array.isArray(data.rich_text)) data.rich_text = (data.rich_text as RichTextItem[]).map(requestRich);
  if (draft.children.length > 0) data.children = draft.children.map(requestBlock);
  return { object: "block", type: draft.type, [draft.type]: data };
};

/** Page content as a test gives it, as the API takes it: Markdown becomes blocks; block objects go as they are. */
const requestContent = (content: string | readonly unknown[]): unknown[] =>
  typeof content === "string" ? markdownToBlocks(content).map(requestBlock) : [...content];

/**
 * The live Notion world (live-mode.md, A1 and A2): people act with their personal access tokens,
 * and every session's pages live in a page of its own, under the page the integration is
 * connected to (or one it can't see), which goes to the trash when the session closes. What it
 * reads and makes is kept in a store of its own with the fake's record shapes, so the routes read
 * from it as from the fake's.
 */
export function createLiveNotionWorld(deps: {
  client: NotionRestClient;
  live: LiveContext;
  ids: IdGenerator;
  clock: Clock;
  /** The integration's name as tests write it (`@my-agent`). */
  appName: string;
}): LiveNotionWorld {
  const { client, live, ids, clock } = deps;
  const registry = new Registry();
  const store = new NotionStore(registry);
  /** The real people the open sessions hold: one record each, whichever sessions have them. */
  const people = new LivePeople();
  const reads = notionReads(store, (session) => [
    ...store.users.list(session),
    ...people.of(session).map((person) => ({ id: person.id, name: person.alias })),
  ]);
  const links = notionLinks(() => NOTION_WEB, reads.titleOf);
  const objects = notionObjects({
    links,
    workspace: () => store.workspace,
    bot: () => store.bot,
    user: (id) => store.user(id),
    database: (id) => store.database(id),
    discussion: (id) => store.discussion(id),
  });
  const appToken = live.vault.fromEnv("CHANNELSTACK_NOTION_TOKEN");
  /** The page each session's pages go in: one the integration sees, and one it doesn't. */
  const homes = new Map<string, { seen?: Promise<string>; unseen?: Promise<string> }>();
  const readAt = new Map<string, number>();
  /** The page the integration is connected to, by hand, once. */
  let root = "";
  const homeName = taggedNames(live.tag);

  const app = (): LiveCredential => {
    if (!appToken)
      throw liveMisconfigured("CHANNELSTACK_NOTION_TOKEN isn't set", "set the agent's integration token (ntn_…)");
    return appToken;
  };
  /** The person acting, who must be real: a fake person can't act in a live workspace (core's rule). */
  const actor = (session: string, userId: string): LiveCredential =>
    people.actingAs(session, userId, () => fakeActorInLiveWorld(store.users.find(userId)?.name ?? userId, "notion"));
  /** Who reads for a session: its first real person, who sees what they made; the integration otherwise. */
  const reader = (session: string): LiveCredential => people.of(session)[0]?.credential ?? app();

  // --- Mirroring what Notion answers ------------------------------------------------------------

  const time = (iso: string) => Date.parse(iso);
  const trashed = (record: { in_trash?: boolean; archived?: boolean }) =>
    record.in_trash === true || record.archived === true;

  /** Someone a record names: a person of the session, the integration, or someone else in the workspace. */
  const ensureUsers = async (ids: Iterable<string>) => {
    for (const id of new Set(ids)) {
      if (store.user(id) || store.users.find(id)) continue;
      let name = "a Notion user";
      try {
        const user = await client.call<{ type: string; name: string | null }>(app(), "get", `users/${id}`);
        // A person's name in Notion can be their email: it never leaves the server.
        if (user.name && !user.name.includes("@")) name = user.name;
      } catch (error) {
        if (!(error instanceof NotionRefusal)) throw error;
      }
      store.users.add(id, { id, name, email: "", avatarUrl: null, fixedId: false } satisfies NotionUserRecord);
    }
  };

  const toPage = (session: string, wire: WirePage, connections: string[] = []): NotionPageRecord => {
    const title = Object.values(wire.properties).find((property) => property.type === "title");
    const known = store.pages.find(wire.id);
    const parent: NotionPageRecord["parent"] =
      wire.parent.type === "page_id"
        ? { type: "page_id", id: wire.parent.page_id as string }
        : wire.parent.type === "database_id" || wire.parent.type === "data_source_id"
          ? {
              type: "database_id",
              id: wire.parent.database_id ?? "",
              dataSource: wire.parent.data_source_id ?? "",
            }
          : { type: "workspace" };
    const record: NotionPageRecord = {
      id: wire.id,
      parent,
      properties: { title: { type: "title", rich: title?.title ?? [] } },
      icon: wire.icon?.type === "emoji" ? (wire.icon.emoji ?? null) : null,
      children: known?.children ?? [],
      connections: known?.connections ?? connections,
      createdBy: wire.created_by.id,
      lastEditedBy: wire.last_edited_by.id,
      createdAt: time(wire.created_time),
      lastEditedAt: time(wire.last_edited_time),
      inTrash: trashed(wire),
    };
    // The same record, changed: a route may hold it across a read.
    if (known) return Object.assign(known, record);
    return store.pages.add(wire.id, record, session);
  };

  const toBlock = (session: string, page: string, wire: WireBlock): NotionBlockRecord => {
    const { children: _children, ...data } = (wire[wire.type] as Record<string, unknown> | undefined) ?? {};
    return store.blocks.add(
      wire.id,
      {
        id: wire.id,
        page,
        parent:
          wire.parent.type === "block_id"
            ? { type: "block_id", id: wire.parent.block_id as string }
            : { type: "page_id", id: page },
        type: wire.type,
        data,
        children: [],
        createdBy: wire.created_by.id,
        lastEditedBy: wire.last_edited_by.id,
        createdAt: time(wire.created_time),
        lastEditedAt: time(wire.last_edited_time),
        inTrash: trashed(wire),
      },
      session,
    );
  };

  /** A page's blocks, read again: nested blocks too, and the pages in it as child pages. */
  const readBlocks = async (session: string, page: NotionPageRecord, by: LiveCredential) => {
    const under = async (parent: string): Promise<string[]> => {
      const found = await client.all<WireBlock>(by, "get", `blocks/${parent}/children`);
      const ids: string[] = [];
      for (const wire of found) {
        const block = toBlock(session, page.id, wire);
        ids.push(block.id);
        if (wire.type === "child_page") {
          // A page in the page: a block with the page's own id, and a page of the session.
          const title = (wire.child_page as { title?: string } | undefined)?.title ?? "";
          const known = store.pages.find(wire.id);
          if (known) known.properties = { title: { type: "title", rich: [textItem(title)] } };
          else
            store.pages.add(
              wire.id,
              {
                id: wire.id,
                parent: { type: "page_id", id: page.id },
                properties: { title: { type: "title", rich: [textItem(title)] } },
                icon: null,
                children: [],
                connections: [],
                createdBy: wire.created_by.id,
                lastEditedBy: wire.last_edited_by.id,
                createdAt: time(wire.created_time),
                lastEditedAt: time(wire.last_edited_time),
                inTrash: trashed(wire),
              },
              session,
            );
        } else if (wire.has_children && wire.type !== "child_database") {
          block.children = await under(wire.id);
        }
      }
      return ids;
    };
    for (const old of store.blocks.values().filter((block) => block.page === page.id && block.type !== "child_page"))
      store.blocks.remove(old.id);
    page.children = await under(page.id);
  };

  const toComment = (session: string, page: string, wire: WireComment): NotionCommentRecord => {
    // What a person did changes the page: the next read asks Notion again.
    readAt.delete(page);
    if (!store.discussions.find(wire.discussion_id)) {
      const block = wire.parent.type === "block_id" ? store.blocks.find(wire.parent.block_id as string) : undefined;
      store.discussions.add(
        wire.discussion_id,
        {
          id: wire.discussion_id,
          page,
          block: block?.id ?? null,
          anchor: block ? reads.blockText(block) : null,
          // Notion's API has no resolved field, and lists no comment of a resolved discussion.
          resolved: false,
          createdAt: time(wire.created_time),
        },
        session,
      );
    }
    return store.comments.add(
      wire.id,
      {
        id: wire.id,
        discussion: wire.discussion_id,
        page,
        rich: wire.rich_text,
        createdBy: wire.created_by.id,
        createdAt: time(wire.created_time),
        lastEditedAt: time(wire.last_edited_time),
        // Only the fake delivers: live, Notion delivers to the agent itself.
        delivery: undefined,
      },
      session,
    );
  };

  /**
   * A page's discussions, read again: on the page, and on the blocks that have one already (Notion
   * lists comments per block, and reading every block's would be a call each).
   */
  const readComments = async (session: string, page: NotionPageRecord, by: LiveCredential) => {
    const anchored = store.discussions
      .values()
      .filter((discussion) => discussion.page === page.id && discussion.block !== null)
      .map((discussion) => discussion.block as string);
    const found: WireComment[] = [];
    for (const target of [page.id, ...new Set(anchored)]) {
      found.push(...(await client.all<WireComment>(by, "get", "comments", { query: { block_id: target } })));
    }
    for (const old of store.comments.values().filter((comment) => comment.page === page.id))
      store.comments.remove(old.id);
    await ensureUsers(found.map((comment) => comment.created_by.id));
    for (const wire of found) toComment(session, page.id, wire);
  };

  /** A page with its blocks and discussions as Notion has them now, unless read a moment ago. */
  const readPage = async (session: string, id: string, force = false) => {
    const last = readAt.get(id);
    if (!force && last !== undefined && clock() - last < READ_CACHE_MS) return store.page(id);
    const by = reader(session);
    const page = toPage(session, await client.call<WirePage>(by, "get", `pages/${id}`));
    await readBlocks(session, page, by);
    await readComments(session, page, by);
    await ensureUsers([page.createdBy, page.lastEditedBy]);
    readAt.set(id, clock());
    return page;
  };

  // --- Where a session's pages go ----------------------------------------------------------------

  /**
   * The session's own page under the integration's page (`seen`) or under one it can't see: made
   * once, by the session's first real person, named with the run's tag, and in the ledger.
   */
  const home = (session: string, seen: boolean, by: LiveCredential): Promise<string> => {
    const homesOf = homes.get(session) ?? {};
    homes.set(session, homesOf);
    const known = seen ? homesOf.seen : homesOf.unseen;
    if (known) return known;
    const made = (async () => {
      const parent = seen ? root : live.vault.setting("CHANNELSTACK_NOTION_UNSEEN_PAGE");
      if (!parent) {
        throw liveMisconfigured(
          "the test makes a page the integration can't see, and there is no page for that",
          "set CHANNELSTACK_NOTION_UNSEEN_PAGE to a page the people can write in and the integration isn't connected to",
        );
      }
      const name = homeName();
      const wire = await client.call<WirePage>(by, "post", "pages", {
        body: { parent: { page_id: parent }, properties: { title: { title: [{ text: { content: name } }] } } },
      });
      live.ledger.record({
        channel: "notion",
        kind: "page",
        ref: { page: wire.id, name },
        workspace: store.workspace.id,
        by: by.owner,
        session,
      });
      toPage(session, wire);
      return wire.id;
    })();
    if (seen) homesOf.seen = made;
    else homesOf.unseen = made;
    made.catch(() => {
      if (seen) delete homesOf.seen;
      else delete homesOf.unseen;
    });
    return made;
  };

  const mentionOfApp = () => userMention(store.bot.id, store.bot.name, true);

  return {
    ...reads,
    store,
    links,
    objects,

    // A network error, a rate limit or the platform's own failure is asked again; anything else is kept.
    ready: checkOnce(async () => {
      const who = await identifyNotion(client, app());
      checkNotionCredential(who, { role: "app", who: "CHANNELSTACK_NOTION_TOKEN", allowlist: live.allowlist });
      store.seed(
        { id: who.workspace.id, name: who.workspace.name },
        {
          id: who.bot,
          integrationId: who.bot,
          subscriptionId: "",
          name: deps.appName,
          events: [],
          capabilities: [],
        },
        { id: NOBODY, name: "Workspace owner", email: "", avatarUrl: null, fixedId: false },
      );
      // The page the integration is connected to: named, or the only top-level page it sees.
      const named = live.vault.setting("CHANNELSTACK_NOTION_PAGE");
      const pages = named
        ? [await client.call<WirePage>(app(), "get", `pages/${named}`)]
        : (
            await client.all<WirePage>(app(), "post", "search", {
              body: { filter: { property: "object", value: "page" } },
            })
          ).filter((page) => page.parent.type === "workspace" && !trashed(page));
      if (pages.length !== 1) {
        throw liveMisconfigured(
          pages.length === 0
            ? "the integration is connected to no page"
            : `the integration sees ${pages.length} top-level pages`,
          "connect it to one page for the tests (… → Connections), or set CHANNELSTACK_NOTION_PAGE to it",
        );
      }
      const [page] = pages as [WirePage];
      root = page.id;
      // The integration's page: every session's pages are under it, and no session can name it,
      // so nothing a test does lands there, outside its own page and the ledger.
      toPage(INTEGRATION_PAGE, page, [who.bot]);
    }, passing),

    release(session) {
      // A person another open session holds stays theirs.
      for (const id of people.leave(session)) store.users.remove(id);
      homes.delete(session);
      for (const page of store.pages.list(session)) readAt.delete(page.id);
      registry.release(session);
    },

    credential(owner, session) {
      if (owner === "app") return appToken;
      return people.byOwner(session, owner);
    },

    async createUser(session, input) {
      if (input.id !== undefined) {
        throw unsupportedInLive(
          "NotionFixture.createUser({ id })",
          "real ids are assigned by Notion; a live person has the id of their account",
        );
      }
      for (const option of ["email", "avatarUrl"] as const) {
        if (input[option] !== undefined) {
          throw unsupportedInLive(
            `NotionFixture.createUser({ ${option} })`,
            `a live person's ${option === "email" ? "email" : "avatar"} is their account's`,
          );
        }
      }
      const named = [
        ...store.users.list(session).map((user) => user.name),
        ...people.of(session).map((person) => person.alias),
      ];
      if (named.some((name) => name.toLowerCase() === input.name.toLowerCase()))
        throw new ProtocolError("invalid_argument", `There is already a person "${input.name}" in this session`);
      if (input.token === undefined) {
        if (live.strict) {
          throw personWithoutToken(input.name, "notion");
        }
        // A fake person can exist next to a live workspace, but can't act in it.
        const id = ids.next(NOTION_IDS.uuid);
        return store.users.add(
          id,
          { id, name: input.name, email: "", avatarUrl: null, fixedId: false } satisfies NotionUserRecord,
          session,
        );
      }
      const key = live.vault.person(input.name, input.token);
      const who = await identifyNotion(client, key);
      checkNotionCredential(who, {
        role: "person",
        who: `${input.name}'s token`,
        allowlist: live.allowlist,
        appWorkspace: store.workspace.id,
      });
      const person = who.person as string;
      people.join(session, person, input.name, key);
      // One record, no session's: parallel tests have the same person. The name the first test
      // gave them (Notion's can be their email, which never leaves the server); another session's
      // name for them resolves its own `@` mentions (`people`), and renames them nowhere.
      const known = store.users.find(person);
      if (known) return known;
      return store.users.add(person, {
        id: person,
        name: input.name,
        email: "",
        avatarUrl: null,
        fixedId: false,
      } satisfies NotionUserRecord);
    },

    async createPage(session, input: PageInput) {
      const creatorId = input.createdBy ?? people.of(session)[0]?.id;
      if (creatorId === undefined) {
        throw actionRequires(
          "NotionFixture.createPage",
          "a real person",
          "a live page is made by a person with a token: create one first (createUser with CHANNELSTACK_NOTION_USER_<NAME>_TOKEN)",
        );
      }
      const by = actor(session, creatorId);
      const connected = (input.connections ?? []).includes(store.bot.id);
      let parent: string;
      if (input.parent !== undefined) {
        parent = input.parent;
        if (connected && !reads.accessible(parent)) {
          throw actionRequires(
            "NotionFixture.createPage({ connections })",
            "the browser actor",
            "the integration can't see the parent, and only Notion's UI connects a page to it",
          );
        }
      } else {
        parent = await home(session, connected, by);
      }
      const wire = await client.call<WirePage>(by, "post", "pages", {
        body: {
          parent: { page_id: parent },
          properties: { title: { title: [{ text: { content: input.title } }] } },
          ...(input.icon ? { icon: { type: "emoji", emoji: input.icon } } : {}),
          ...(input.content !== undefined ? { children: requestContent(input.content) } : {}),
        },
      });
      toPage(session, wire);
      return { page: await readPage(session, wire.id, true), delivery: undefined };
    },

    async edit(session, page, change, userId) {
      const by = actor(session, userId);
      if (change.replace !== undefined) {
        for (const block of reads.childrenOf(page.children)) {
          if (block.type === "child_page") continue;
          await client.call(by, "delete", `blocks/${block.id}`);
        }
        await client.call(by, "patch", `blocks/${page.id}/children`, {
          body: { children: requestContent(change.replace) },
        });
      }
      if (change.append !== undefined) {
        await client.call(by, "patch", `blocks/${page.id}/children`, {
          body: { children: requestContent(change.append) },
        });
      }
      await readPage(session, page.id, true);
    },

    async rename(session, page, title, userId) {
      await client.call(actor(session, userId), "patch", `pages/${page.id}`, {
        body: { properties: { title: { title: [{ text: { content: title } }] } } },
      });
      await readPage(session, page.id, true);
      return undefined;
    },

    async mention(session, page, inBlock, userId) {
      const by = actor(session, userId);
      if (inBlock === undefined) {
        await client.call(by, "patch", `blocks/${page.id}/children`, {
          body: { children: [{ type: "paragraph", paragraph: { rich_text: [requestRich(mentionOfApp())] } }] },
        });
      } else {
        const block = reads.blockWith(page, inBlock);
        const rich = (block.data.rich_text as RichTextItem[] | undefined) ?? [];
        await client.call(by, "patch", `blocks/${block.id}`, {
          body: { [block.type]: { rich_text: [...rich, textItem(" "), mentionOfApp()].map(requestRich) } },
        });
      }
      await readPage(session, page.id, true);
    },

    async comment(session, page, rich, userId, anchor) {
      const by = actor(session, userId);
      const block = anchor === undefined ? undefined : reads.blockWith(page, anchor);
      const wire = await client.call<WireComment>(by, "post", "comments", {
        body: {
          parent: block ? { block_id: block.id } : { page_id: page.id },
          rich_text: rich.map(requestRich),
        },
      });
      return toComment(session, page.id, wire);
    },

    async reply(session, discussion, rich, userId) {
      const wire = await client.call<WireComment>(actor(session, userId), "post", "comments", {
        body: { discussion_id: discussion.id, rich_text: rich.map(requestRich) },
      });
      return toComment(session, discussion.page, wire);
    },

    async editComment(session, comment, rich, userId) {
      const wire = await client.call<WireComment>(actor(session, userId), "patch", `comments/${comment.id}`, {
        body: { rich_text: rich.map(requestRich) },
      });
      toComment(session, comment.page, wire);
      return undefined;
    },

    async deleteComment(session, comment, userId) {
      await client.call(actor(session, userId), "delete", `comments/${comment.id}`);
      store.comments.remove(comment.id);
      readAt.delete(comment.page);
      return undefined;
    },

    async refresh(session, about) {
      const page =
        "page" in about
          ? about.page
          : (store.discussions.get(session, about.discussion) as NotionDiscussionRecord).page;
      await readPage(session, page);
    },
  };
}
