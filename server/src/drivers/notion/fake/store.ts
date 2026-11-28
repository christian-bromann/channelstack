import { AppRoster } from "../../../core/apps/index.ts";
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
  /** The built-in integration and the ones tests made (decision 0027), all in the one workspace. */
  readonly apps: AppRoster<NotionBotRecord>;
  #owner: NotionUserRecord | undefined;

  constructor(registry: Registry) {
    this.apps = new AppRoster("Notion", registry);
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

  /** The built-in integration's bot user, `my-agent`. It belongs to no session. */
  get bot(): NotionBotRecord {
    return this.apps.builtIn;
  }

  /** The integration whose bot user this is, if any. */
  integration(id: string): NotionBotRecord | undefined {
    return this.apps.all().find((app) => app.id === id);
  }

  /** The workspace owner: who seed data is created by unless a test says otherwise. */
  get owner(): NotionUserRecord {
    if (!this.#owner) throw new Error("The Notion fake hasn't been seeded");
    return this.#owner;
  }

  seed(workspace: NotionWorkspaceRecord, bot: NotionBotRecord, owner: NotionUserRecord): void {
    this.#workspace = workspace;
    this.apps.seed(bot);
    this.#owner = owner;
  }

  /** Whoever acts under this id: a person, the owner, or an integration's bot. */
  user(id: string): NotionUserRecord | NotionBotRecord | undefined {
    const bot = this.integration(id);
    if (bot) return bot;
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
