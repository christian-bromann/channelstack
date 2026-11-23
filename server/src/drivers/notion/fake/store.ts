import type { Collection, Registry } from "../../../core/registry/index.ts";
import type {
  NotionBlockRecord,
  NotionBotRecord,
  NotionCommentRecord,
  NotionDatabaseRecord,
  NotionDiscussionRecord,
  NotionPageRecord,
  NotionUserRecord,
  NotionWorkspaceRecord,
} from "../world.ts";

/** The Notion fake's in-memory state. Objects live in the core registry; the store adds Notion's own lookups. */
export class NotionStore {
  readonly users: Collection<NotionUserRecord>;
  readonly pages: Collection<NotionPageRecord>;
  readonly databases: Collection<NotionDatabaseRecord>;
  readonly blocks: Collection<NotionBlockRecord>;
  readonly discussions: Collection<NotionDiscussionRecord>;
  readonly comments: Collection<NotionCommentRecord>;
  #workspace: NotionWorkspaceRecord | undefined;
  #bot: NotionBotRecord | undefined;
  #owner: NotionUserRecord | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection("notion", "user");
    this.pages = registry.collection("notion", "page");
    this.databases = registry.collection("notion", "database");
    this.blocks = registry.collection("notion", "block");
    this.discussions = registry.collection("notion", "discussion");
    this.comments = registry.collection("notion", "comment");
  }

  get workspace(): NotionWorkspaceRecord {
    if (!this.#workspace) throw new Error("The Notion fake hasn't been seeded");
    return this.#workspace;
  }

  /** The integration's bot user. It belongs to no session. */
  get bot(): NotionBotRecord {
    if (!this.#bot) throw new Error("The Notion fake hasn't been seeded");
    return this.#bot;
  }

  /** The workspace owner: who seed data is created by unless a test says otherwise. */
  get owner(): NotionUserRecord {
    if (!this.#owner) throw new Error("The Notion fake hasn't been seeded");
    return this.#owner;
  }

  seed(workspace: NotionWorkspaceRecord, bot: NotionBotRecord, owner: NotionUserRecord): void {
    this.#workspace = workspace;
    this.#bot = bot;
    this.#owner = owner;
  }

  /** Whoever acts under this id: a person, the owner, or the bot. */
  user(id: string): NotionUserRecord | NotionBotRecord | undefined {
    if (id === this.bot.id) return this.bot;
    if (id === this.owner.id) return this.owner;
    return this.users.find(id);
  }

  /** The session something belongs to: its page's, or its own. */
  sessionOf(id: string): string {
    const session =
      this.pages.owner(id) ??
      this.databases.owner(id) ??
      this.blocks.owner(id) ??
      this.comments.owner(id) ??
      this.discussions.owner(id);
    if (session === undefined) throw new Error(`Notion object ${id} belongs to no session`);
    return session;
  }

  page(id: string): NotionPageRecord {
    const page = this.pages.find(id);
    if (!page) throw new Error(`No Notion page ${id}`);
    return page;
  }

  block(id: string): NotionBlockRecord {
    const block = this.blocks.find(id);
    if (!block) throw new Error(`No Notion block ${id}`);
    return block;
  }

  database(id: string): NotionDatabaseRecord {
    const database = this.databases.find(id);
    if (!database) throw new Error(`No Notion database ${id}`);
    return database;
  }

  /** A database by its data source's id. */
  dataSource(id: string): NotionDatabaseRecord | undefined {
    return this.databases.values().find((database) => database.dataSource === id);
  }

  discussion(id: string): NotionDiscussionRecord {
    const discussion = this.discussions.find(id);
    if (!discussion) throw new Error(`No Notion discussion ${id}`);
    return discussion;
  }

  /** The pages directly under a page or a database. */
  childPages(parent: string): NotionPageRecord[] {
    return this.pages
      .values()
      .filter((page) => page.parent.type !== "workspace" && page.parent.id === parent && !page.inTrash);
  }

  discussionsOn(page: string): NotionDiscussionRecord[] {
    return this.discussions.values().filter((discussion) => discussion.page === page);
  }

  commentsIn(discussion: string): NotionCommentRecord[] {
    return this.comments.values().filter((comment) => comment.discussion === discussion);
  }
}
