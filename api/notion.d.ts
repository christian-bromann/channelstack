import type {
  App, Delivery, DeliveryAttempt, Duration, HasTranscript, Inspectable, QuietOptions,
  Resource, RichText, Timestamp, User, WaitOptions,
} from "./common";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The `notion` test fixture: one in-memory workspace. */
export interface NotionFixture extends Inspectable<NotionDelivery> {
  /** The agent's integration from `channelstack.config.ts`. Connect it to pages explicitly. */
  readonly app: NotionIntegration;
  /** Base URL to give the agent (`@notionhq/client` `baseUrl`), e.g. `https://notion.localhost`. */
  readonly apiUrl: string;

  createUser(options: NotionUserOptions): Promise<NotionUser>;

  /**
   * Create a page as seed data. The integration can only read it, and only gets
   * webhooks for it, when it's listed in `connections` or inherits a connection from
   * its parent (Notion's real rule). Use `user.createPage` when the creation itself
   * should reach the agent as an event.
   */
  createPage(options: NotionPageOptions): Promise<NotionPage>;
  createDatabase(options: NotionDatabaseOptions): Promise<NotionDatabase>;

  /** Fake only: how long `page.content_updated` waits to batch edits, for this test. Default "1s". */
  setContentUpdateDelay(delay: Duration): Promise<void>;
  /** Fake only: send the subscription's verification request (`{ verification_token }`), as Notion does once. */
  sendVerification(): Promise<NotionDelivery | undefined>;
}

export interface NotionUserOptions {
  name: string;
  /** Fixed id (UUID), for agents that allowlist by id. */
  id?: string;
  email?: string;
  avatarUrl?: string;
  /**
   * A real person in a live workspace: their personal access token, which acts as them.
   * Also read from `CHANNELSTACK_NOTION_USER_<NAME>_TOKEN`.
   */
  token?: string;
  /** Live only: lets the browser actor do UI-only actions (Add connections). Sign-in is unattended. */
  browser?: { storageState: string };
}

export interface NotionPageOptions {
  title: string;
  parent?: NotionPage;
  /** Initial content: Markdown, or Notion block objects as the API takes them. */
  content?: string | unknown[];
  icon?: string;
  connections?: NotionIntegration[];
  /** Shown as the page's creator. Defaults to a generated workspace owner. */
  createdBy?: NotionUser;
}

export interface NotionDatabaseOptions {
  title: string;
  parent?: NotionPage;
  /** Property schema, e.g. `{ Status: { select: ["Todo", "Done"] }, Owner: "people" }`. */
  properties: Record<string, NotionPropertySchema>;
  rows?: Array<Record<string, NotionPropertyValue>>;
  connections?: NotionIntegration[];
}

export type NotionPropertySchema =
  | "title" | "rich_text" | "number" | "checkbox" | "date" | "people" | "url" | "email"
  | { select: string[] }
  | { multi_select: string[] }
  | { status: string[] }
  | { relation: NotionDatabase };

export type NotionPropertyValue = string | number | boolean | null | string[] | NotionUser | NotionUser[] | { start: string; end?: string };

// ---------------------------------------------------------------------------
// People: every action a person takes lives here
// ---------------------------------------------------------------------------

/**
 * A person in the workspace. Content first, where it happens as an option:
 * `ana.comment("@my-agent summarize this", { page })`, `ben.reply("thanks", { discussion })`.
 */
export interface NotionUser extends User {
  readonly channel: "notion";
  readonly email?: string;

  // ------------------------------------------------------------ comments
  /**
   * Start a discussion: page-level, or anchored to the block containing `anchor`.
   * Sends `comment.created`.
   */
  comment(text: RichText, where: { page: NotionPage; anchor?: string }): Promise<NotionComment>;
  reply(text: RichText, where: { discussion: NotionDiscussion }): Promise<NotionComment>;
  editComment(text: RichText, target: { comment: NotionComment }): Promise<NotionDelivery | undefined>;
  deleteComment(target: { comment: NotionComment }): Promise<NotionDelivery | undefined>;
  resolve(target: { discussion: NotionDiscussion }): Promise<NotionDelivery | undefined>;
  reopen(target: { discussion: NotionDiscussion }): Promise<NotionDelivery | undefined>;

  // ------------------------------------------------------------ pages
  /** Create a page as this person. Unlike `notion.createPage`, this sends `page.created`. */
  createPage(page: Omit<NotionPageOptions, "createdBy">): Promise<NotionPage>;
  /** Edit the body. Sends `page.content_updated`. */
  edit(change: { append?: string | unknown[]; replace?: string | unknown[] }, target: { page: NotionPage }): Promise<NotionDelivery | undefined>;
  rename(title: string, target: { page: NotionPage }): Promise<NotionDelivery | undefined>;
  /** Mention the integration inside the page body (not in a comment). */
  mention(integration: NotionIntegration, where: { page: NotionPage; inBlock?: string }): Promise<NotionDelivery | undefined>;
  setProperty(name: string, value: NotionPropertyValue, target: { page: NotionPage }): Promise<NotionDelivery | undefined>;
  addRow(values: Record<string, NotionPropertyValue>, where: { database: NotionDatabase }): Promise<NotionPage>;
  /** Connect an integration to a page (Share → Connections). */
  connect(integration: NotionIntegration, target: { page: NotionPage }): Promise<void>;
  disconnect(integration: NotionIntegration, target: { page: NotionPage }): Promise<void>;
}

export interface NotionIntegration extends App {
  readonly channel: "notion";
  /** Internal integration token (`ntn_…`). Also printed by `channelstack env`. */
  readonly token: string;
  /** Secret used to sign webhook deliveries. */
  readonly webhookSecret: string;
}

export type NotionAuthor = NotionUser | NotionIntegration;

// ---------------------------------------------------------------------------
// Pages, databases, discussions: what you read and wait on
// ---------------------------------------------------------------------------

export interface NotionPage extends Resource, HasTranscript {
  readonly channel: "notion";
  readonly title: string;
  readonly url: string;
  discussions(): Promise<NotionDiscussion[]>;
  /** The page body as Markdown, as the agent last left it. */
  markdown(): Promise<string>;
  blocks(): Promise<unknown[]>;
  property(name: string): Promise<NotionPropertyValue>;
  children(): Promise<NotionPage[]>;
  connections(): Promise<NotionIntegration[]>;
}

export interface NotionDatabase extends Resource {
  readonly channel: "notion";
  readonly title: string;
  readonly url: string;
  rows(filter?: Record<string, NotionPropertyValue>): Promise<NotionPage[]>;
}

export interface NotionDiscussion extends HasTranscript {
  readonly id: string;
  readonly page: NotionPage;
  /** The text the discussion is anchored to, or undefined for a page-level discussion. */
  readonly anchor?: string;
  comments(): Promise<NotionComment[]>;
  /** Wait for the next new comment matching `from` (any author if omitted), after the last one seen. */
  waitForComment(options?: { from?: NotionAuthor | string } & WaitOptions): Promise<NotionComment>;
  /** The latest comment matching `from`, once the agent is quiet. Waits for at least one. */
  latestComment(options?: { from?: NotionAuthor | string } & QuietOptions): Promise<NotionComment>;
  resolved(): Promise<boolean>;
}

export interface NotionComment {
  readonly id: string;
  readonly discussion: NotionDiscussion;
  readonly author: NotionAuthor;
  readonly text: string;
  readonly createdAt: Timestamp;
  /** The `comment.created` delivery, if the integration is connected and subscribed. */
  readonly delivery?: NotionDelivery;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface NotionDelivery extends Delivery {
  readonly channel: "notion";
  /** e.g. `comment.created`, `page.content_updated`, `page.properties_updated`. */
  readonly type: string;
  readonly entity: { type: "page" | "database" | "comment" | "block"; id: string };
}

export type { DeliveryAttempt };
