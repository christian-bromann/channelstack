import type { RetryPolicy } from "../../../core/delivery/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { randomToken } from "../../../core/secrets/index.ts";
import { signNotionWebhook } from "../../../core/signing/notion.ts";
import { NotionApiError } from "../errors.ts";
import { notionLinks } from "../links.ts";
import { type BlockDraft, markdownToBlocks } from "../markdown.ts";
import { notionObjects } from "../objects.ts";
import { type Author, type EventParent, notionPayloads, stampAttempt } from "../payloads.ts";
import { notionReads, type TextPattern } from "../reads.ts";
import { plainText, type RichTextItem, textItem, userMention } from "../rich-text.ts";
import type {
  NotionBlockRecord,
  NotionCommentRecord,
  NotionDatabaseRecord,
  NotionDiscussionRecord,
  NotionPageRecord,
  NotionParent,
  NotionPropertyRecord,
  NotionPropertyType,
  NotionUserRecord,
  NotionValue,
} from "../world.ts";
import type { NotionStore } from "./store.ts";

/** Notion waits a few seconds for an answer before it counts the attempt as failed. */
const ACK_WINDOW_MS = 5_000;
/** Notion retries up to eight times, backing off, over about a day. */
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000];
const NOTION_RETRIES: RetryPolicy = {
  next(_attempt, retries) {
    const afterMs = RETRY_DELAYS_MS[retries];
    return afterMs === undefined ? undefined : { afterMs, headers: {} };
  },
};
/** How long `page.content_updated` waits to batch edits, unless a test sets another delay. */
const DEFAULT_CONTENT_DELAY_MS = 1_000;
const OPTION_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

const invalid = (message: string) => new NotionApiError(400, "validation_error", message);
const unseen = (kind: string, id: string) =>
  new NotionApiError(
    404,
    "object_not_found",
    `Could not find ${kind} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  );

/** A property's value as a test gives it (`NotionPropertyValue`): plain values, option names, ids. */
export type PlainValue = string | number | boolean | null | string[] | { start: string; end?: string | undefined };

export interface PageInput {
  title: string;
  parent?: string | undefined;
  content?: string | unknown[] | undefined;
  icon?: string | undefined;
  connections?: readonly string[] | undefined;
  createdBy?: string | undefined;
}

export interface DatabaseInput {
  title: string;
  parent?: string | undefined;
  properties: Record<string, unknown>;
  rows?: ReadonlyArray<Record<string, PlainValue>> | undefined;
  connections?: readonly string[] | undefined;
}

/**
 * The fake Notion world: every change happens here once, for people (through the control API)
 * and for the integration (through the REST API) alike. The caller brings the permission check.
 */
export function createFakeWorld(context: DriverContext, store: NotionStore) {
  const { ids, clock, delivery, timers } = context;
  const links = notionLinks(context.apiUrl, (page) => titleOf(page));
  const objects = notionObjects({
    links,
    workspace: () => store.workspace,
    bot: () => store.bot,
    user: (id) => store.user(id),
    database: (id) => store.database(id),
    discussion: (id) => store.discussion(id),
  });
  const payloads = notionPayloads({ workspace: () => store.workspace, bot: () => store.bot });

  // --- Reading the workspace ------------------------------------------------------------------

  const reads = notionReads(store);
  const { titleOf, isBot, accessible, childrenOf, blockText, blockWith } = reads;
  const author = (id: string): Author => ({ id, type: isBot(id) ? "bot" : "person" });

  /** The page or database an id names, if the integration may see it; Notion's 404 otherwise. */
  const visiblePage = (id: string): NotionPageRecord => {
    const page = store.pages.find(id);
    if (!page || !accessible(page.id)) throw unseen("page", id);
    return page;
  };
  const visibleDatabase = (id: string): NotionDatabaseRecord => {
    const database = store.databases.find(id) ?? store.dataSource(id);
    if (!database || !accessible(database.id)) throw unseen("database", id);
    return database;
  };
  /** A block or a page by id: what `blocks.*` takes, since a page is a block too. */
  const visibleBlock = (id: string): { block?: NotionBlockRecord; page: NotionPageRecord } => {
    // A page is a block too: its children are the page's content.
    const page = store.pages.find(id);
    if (page && accessible(page.id)) return { page };
    const block = store.blocks.find(id);
    if (block && !block.inTrash && block.type !== "child_page" && accessible(block.page))
      return { block, page: store.page(block.page) };
    throw unseen("block", id);
  };

  /** Where a page is, as an event names it. */
  const eventParent = (page: NotionPageRecord): EventParent => {
    switch (page.parent.type) {
      case "workspace":
        return { id: store.workspace.id, type: "space" };
      case "page_id":
        return { id: page.parent.id, type: "page" };
      case "database_id":
        return { id: page.parent.id, type: "database", data_source_id: page.parent.dataSource };
    }
  };

  // --- Webhooks -------------------------------------------------------------------------------

  /** Per test session: how long content updates wait to be batched. */
  const contentDelay = new Map<string, number>();
  /** Content updates waiting to go out, by page: one event names every block changed meanwhile. */
  const pendingContent = new Map<string, { session: string; blocks: Set<string>; authors: Map<string, Author> }>();

  /** Notion's headers for an event, signed with this token over the exact body. */
  const signedWith = (token: string) => (body: string) => ({
    "user-agent": "notion-api",
    ...signNotionWebhook(token, body),
  });

  /**
   * Send an event to the agent if the integration is subscribed to it, may see the page and has a
   * URL. Every attempt is stamped with its number and signed with the verification token.
   */
  const emit = (
    session: string,
    page: NotionPageRecord,
    type: string,
    build: (id: string) => Record<string, unknown>,
  ): string | undefined => {
    if (!store.bot.events.includes(type) || !accessible(page.id) || context.webhookUrl === undefined) return undefined;
    if (type.startsWith("comment.") && !store.bot.capabilities.includes("read_comments")) return undefined;
    const id = ids.next("notion.uuid");
    const payload = build(id);
    const entity = payload.entity as { id: string; type: string };
    delivery.enqueue({
      id,
      session,
      driver: "notion",
      type,
      url: context.webhookUrl,
      body: JSON.stringify(payload),
      stamp: stampAttempt,
      sign: signedWith(context.secret("verificationToken")),
      timeoutMs: ACK_WINDOW_MS,
      retry: NOTION_RETRIES,
      meta: { payload, entity, page: page.id },
    });
    return id;
  };

  /** Hold a content update for the page's batch; the first one starts the delay. */
  const contentUpdated = (session: string, page: NotionPageRecord, blocks: readonly string[], actor: string) => {
    let batch = pendingContent.get(page.id);
    if (!batch) {
      batch = { session, blocks: new Set(), authors: new Map() };
      pendingContent.set(page.id, batch);
      timers.after(contentDelay.get(session) ?? DEFAULT_CONTENT_DELAY_MS, () => {
        const sent = pendingContent.get(page.id);
        pendingContent.delete(page.id);
        if (!sent || !store.pages.find(page.id)) return;
        emit(session, page, "page.content_updated", (id) =>
          payloads.contentUpdated(id, clock(), [...sent.authors.values()], page.id, eventParent(page), [
            ...sent.blocks,
          ]),
        );
      });
    }
    for (const block of blocks) batch.blocks.add(block);
    batch.authors.set(actor, author(actor));
  };

  const touch = (page: NotionPageRecord, actor: string) => {
    page.lastEditedAt = clock();
    page.lastEditedBy = actor;
  };

  // --- Blocks ---------------------------------------------------------------------------------

  /** Page content as a test or the API gives it: Markdown, or block objects. */
  const draftsOf = (content: string | readonly unknown[]): BlockDraft[] =>
    typeof content === "string" ? markdownToBlocks(content) : content.map(draftFromRequest);

  /** A block object as the API takes it (`{ type, [type]: {…}, children? }`). */
  const draftFromRequest = (raw: unknown): BlockDraft => {
    const input = raw as Record<string, unknown> | null;
    const type =
      typeof input?.type === "string" ? input.type : Object.keys(input ?? {}).find((key) => key !== "object");
    if (!input || type === undefined || typeof input[type] !== "object" || input[type] === null)
      throw invalid("body failed validation: a block needs its type's object, e.g. `paragraph: { rich_text }`");
    const { children, ...data } = input[type] as Record<string, unknown> & { children?: unknown[] };
    if ("rich_text" in data) data.rich_text = richFromRequest(data.rich_text);
    if (type !== "divider" && !("color" in data) && "rich_text" in data) data.color = "default";
    if (type === "to_do") data.checked = data.checked === true;
    if (type === "code") {
      data.language ??= "plain text";
      data.caption ??= [];
    }
    if (type.startsWith("heading_")) data.is_toggleable ??= false;
    return {
      type,
      data,
      children: (children ?? (input.children as unknown[] | undefined) ?? []).map(draftFromRequest),
    };
  };

  /** Rich text from the API, made complete: plain text worked out, mentions named. */
  const richFromRequest = (input: unknown): RichTextItem[] => {
    if (!Array.isArray(input)) throw invalid("body failed validation: rich_text should be an array");
    return input.map((raw, index) => {
      const item = raw as {
        text?: { content?: unknown; link?: { url?: unknown } | null };
        mention?: { user?: { id?: unknown } };
        annotations?: Partial<RichTextItem["annotations"]>;
      };
      if (typeof item?.text?.content === "string") {
        if (item.text.content.length > 2000)
          throw invalid(`body failed validation: rich_text[${index}].text.content.length should be ≤ \`2000\``);
        const link = typeof item.text.link?.url === "string" ? item.text.link.url : null;
        return textItem(item.text.content, item.annotations ?? {}, link);
      }
      const mentioned = typeof item?.mention?.user?.id === "string" ? store.user(item.mention.user.id) : undefined;
      if (mentioned) return userMention(mentioned.id, mentioned.name);
      throw invalid(`body failed validation: rich_text[${index}] should be \`text\` or a user \`mention\``);
    });
  };

  /** Make blocks from drafts under a parent; answers with the top-level ids. */
  const insertBlocks = (
    session: string,
    page: NotionPageRecord,
    parent: NotionBlockRecord["parent"],
    drafts: readonly BlockDraft[],
    actor: string,
  ): string[] =>
    drafts.map((draft) => {
      const now = clock();
      const id = ids.next("notion.uuid");
      const block = store.blocks.add(
        id,
        {
          id,
          page: page.id,
          parent,
          type: draft.type,
          data: draft.data,
          children: [],
          createdBy: actor,
          lastEditedBy: actor,
          createdAt: now,
          lastEditedAt: now,
          inTrash: false,
        },
        session,
      );
      block.children = insertBlocks(session, page, { type: "block_id", id }, draft.children, actor);
      return id;
    });

  /** Append blocks to a page or a block, at the end or after one of its children. */
  const append = (
    session: string,
    target: { block?: NotionBlockRecord; page: NotionPageRecord },
    content: string | readonly unknown[],
    actor: string,
    after?: string,
  ): string[] => {
    const parent = target.block
      ? { type: "block_id" as const, id: target.block.id }
      : { type: "page_id" as const, id: target.page.id };
    // Everything is checked before a block is made, so a refused append leaves nothing behind.
    const list = target.block ? target.block.children : target.page.children;
    const at = after === undefined ? list.length : list.indexOf(after) + 1;
    if (after !== undefined && at === 0) throw invalid(`body failed validation: ${after} is not a child of this block`);
    const drafts = draftsOf(content);
    const added = insertBlocks(session, target.page, parent, drafts, actor);
    list.splice(at, 0, ...added);
    touch(target.page, actor);
    contentUpdated(session, target.page, added, actor);
    return added;
  };

  const updateBlock = (session: string, block: NotionBlockRecord, input: Record<string, unknown>, actor: string) => {
    if (input.in_trash === true || input.archived === true) return removeBlock(session, block, actor);
    const changes = input[block.type] as Record<string, unknown> | undefined;
    if (changes === undefined)
      throw invalid(`body failed validation: a ${block.type} block is updated with \`${block.type}\``);
    const { rich_text, ...rest } = changes;
    block.data = {
      ...block.data,
      ...rest,
      ...(rich_text === undefined ? {} : { rich_text: richFromRequest(rich_text) }),
    };
    block.lastEditedAt = clock();
    block.lastEditedBy = actor;
    const page = store.page(block.page);
    touch(page, actor);
    contentUpdated(session, page, [block.id], actor);
    return block;
  };

  const removeBlock = (session: string, block: NotionBlockRecord, actor: string) => {
    block.inTrash = true;
    block.lastEditedAt = clock();
    block.lastEditedBy = actor;
    const page = store.page(block.page);
    touch(page, actor);
    contentUpdated(session, page, [block.id], actor);
    return block;
  };

  // --- Properties -----------------------------------------------------------------------------

  /** The properties a page has where it is: its database's, or just a title. */
  const schemaFor = (parent: NotionParent): NotionPropertyRecord[] =>
    parent.type === "database_id"
      ? store.database(parent.id).properties
      : [{ id: "title", name: "title", type: "title", options: [] }];
  const schemaOf = (page: NotionPageRecord): NotionPropertyRecord[] => schemaFor(page.parent);

  const propertyNamed = (page: { parent: NotionParent }, name: string): NotionPropertyRecord => {
    const schema = schemaFor(page.parent);
    const found = schema.find((property) => property.name === name || property.id === name);
    if (!found)
      throw invalid(
        `body failed validation: ${name} is not a property that exists. Its properties: ${schema.map((p) => p.name).join(", ")}`,
      );
    return found;
  };

  /** Find an option by name, or (as Notion does for `select` and `multi_select`) add it. */
  const optionNamed = (property: NotionPropertyRecord, name: string): string => {
    if (property.type === "status" && !property.options.some((option) => option.name === name))
      throw invalid(`body failed validation: "${name}" is not an option of the status property ${property.name}`);
    return name;
  };

  /**
   * A select's or multi-select's new option names become options of the schema: only once every
   * value of the change was checked, so a refused change adds none.
   */
  const addOptions = (schema: readonly NotionPropertyRecord[], values: Record<string, NotionValue>) => {
    for (const property of schema) {
      const value = values[property.name];
      const names = value?.type === "select" ? [value.option] : value?.type === "multi_select" ? value.options : [];
      for (const name of names)
        if (name !== null && !property.options.some((option) => option.name === name))
          property.options.push({
            id: ids.next("notion.uuid"),
            name,
            color: OPTION_COLORS[property.options.length % 10] ?? "default",
          });
    }
  };

  /** A test's value (`"Done"`, `3`, `["a", "b"]`) as the value of a property of this type. */
  const fromPlain = (property: NotionPropertyRecord, value: PlainValue): NotionValue => {
    const reject = () =>
      new ProtocolError(
        "invalid_argument",
        `${JSON.stringify(value)} is not a value for ${property.name} (${property.type})`,
      );
    switch (property.type) {
      case "title":
      case "rich_text":
        if (typeof value !== "string") throw reject();
        return { type: property.type, rich: [textItem(value)] };
      case "number":
        if (typeof value !== "number" && value !== null) throw reject();
        return { type: "number", value };
      case "checkbox":
        if (typeof value !== "boolean") throw reject();
        return { type: "checkbox", value };
      case "select":
      case "status":
        if (typeof value !== "string" && value !== null) throw reject();
        return { type: property.type, option: value === null ? null : optionNamed(property, value) };
      case "multi_select":
        if (!Array.isArray(value)) throw reject();
        return { type: "multi_select", options: value.map((name) => optionNamed(property, name)) };
      case "date":
        if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw reject();
        return { type: "date", value: value === null ? null : { start: value.start, end: value.end ?? null } };
      case "people":
      case "relation":
        if (!Array.isArray(value)) throw reject();
        return { type: property.type, ids: [...value] };
      case "url":
      case "email":
        if (typeof value !== "string" && value !== null) throw reject();
        return { type: property.type, value };
    }
  };

  /** A property value as the API takes it (`{ number: 3 }`, `{ status: { name } }`, `{ title: [...] }`). */
  const fromRequest = (property: NotionPropertyRecord, raw: unknown): NotionValue => {
    const input = raw as Record<string, unknown> | null;
    const inner = input?.[property.type];
    const fail = () => invalid(`body failed validation: ${property.name} is expected to be ${property.type}`);
    if (input === null || typeof input !== "object" || !(property.type in input)) throw fail();
    switch (property.type) {
      case "title":
      case "rich_text":
        return { type: property.type, rich: richFromRequest(inner) };
      case "select":
      case "status": {
        const name = (inner as { name?: unknown } | null)?.name;
        if (inner !== null && typeof name !== "string") throw fail();
        return { type: property.type, option: inner === null ? null : optionNamed(property, name as string) };
      }
      case "multi_select":
        if (!Array.isArray(inner)) throw fail();
        return { type: "multi_select", options: inner.map((option) => optionNamed(property, String(option?.name))) };
      case "people":
      case "relation":
        if (!Array.isArray(inner)) throw fail();
        return { type: property.type, ids: inner.map((entry) => String(entry?.id)) };
      case "date": {
        const date = inner as { start?: unknown; end?: unknown } | null;
        if (date !== null && typeof date?.start !== "string") throw fail();
        return {
          type: "date",
          value:
            date === null ? null : { start: String(date.start), end: typeof date.end === "string" ? date.end : null },
        };
      }
      default:
        // A number, checkbox, url or email: the plain value, which Notion checks for its type.
        try {
          return fromPlain(property, inner as PlainValue);
        } catch (error) {
          if (error instanceof ProtocolError) throw fail();
          throw error;
        }
    }
  };

  /** What a person reads in a property: text, a number, option names, ids. */
  const toPlain = (value: NotionValue | undefined): PlainValue => {
    if (value === undefined) return null;
    switch (value.type) {
      case "title":
      case "rich_text":
        return plainText(value.rich);
      case "select":
      case "status":
        return value.option;
      case "multi_select":
        return [...value.options];
      case "people":
      case "relation":
        return [...value.ids];
      case "date":
        return value.value === null
          ? null
          : { start: value.value.start, ...(value.value.end ? { end: value.value.end } : {}) };
      default:
        return value.value;
    }
  };

  const setProperties = (
    session: string,
    page: NotionPageRecord,
    values: Record<string, NotionValue>,
    actor: string,
  ) => {
    const changed = Object.keys(values).map((name) => propertyNamed(page, name));
    addOptions(changed, values);
    for (const property of changed) page.properties[property.name] = values[property.name] as NotionValue;
    touch(page, actor);
    return emit(session, page, "page.properties_updated", (id) =>
      payloads.propertiesUpdated(
        id,
        clock(),
        [author(actor)],
        page.id,
        eventParent(page),
        changed.map((p) => p.id),
      ),
    );
  };

  // --- Pages and databases --------------------------------------------------------------------

  const parentOf = (id: string | undefined): NotionParent => {
    if (id === undefined) return { type: "workspace" };
    if (store.pages.find(id)) return { type: "page_id", id };
    const database = store.databases.find(id) ?? store.dataSource(id);
    if (database) return { type: "database_id", id: database.id, dataSource: database.dataSource };
    throw new ProtocolError("not_found", `No Notion page or database ${id}`);
  };

  const makePage = (
    session: string,
    parent: NotionParent,
    properties: Record<string, NotionValue>,
    actor: string,
    extra: { icon?: string | undefined; connections?: readonly string[] | undefined } = {},
  ): NotionPageRecord => {
    const now = clock();
    const id = ids.next("notion.uuid");
    const page = store.pages.add(
      id,
      {
        id,
        parent,
        properties,
        icon: extra.icon ?? null,
        children: [],
        connections: [...(extra.connections ?? [])],
        createdBy: actor,
        lastEditedBy: actor,
        createdAt: now,
        lastEditedAt: now,
        inTrash: false,
      },
      session,
    );
    // A page made inside another page is also a `child_page` block of it, with the page's own id.
    if (parent.type === "page_id") {
      const above = store.page(parent.id);
      store.blocks.add(
        id,
        {
          id,
          page: above.id,
          parent: { type: "page_id", id: above.id },
          type: "child_page",
          data: { title: "" },
          children: [],
          createdBy: actor,
          lastEditedBy: actor,
          createdAt: now,
          lastEditedAt: now,
          inTrash: false,
        },
        session,
      );
      above.children.push(id);
    }
    return page;
  };

  const announcePage = (session: string, page: NotionPageRecord, actor: string) =>
    emit(session, page, "page.created", (id) =>
      payloads.pageCreated(id, clock(), [author(actor)], page.id, eventParent(page)),
    );

  const createPage = (session: string, input: PageInput, options: { announce: boolean }) => {
    const actor = input.createdBy ?? store.owner.id;
    const page = makePage(
      session,
      parentOf(input.parent),
      { title: { type: "title", rich: [textItem(input.title)] } },
      actor,
      input,
    );
    if (input.content !== undefined)
      page.children = insertBlocks(session, page, { type: "page_id", id: page.id }, draftsOf(input.content), actor);
    const sent = options.announce ? announcePage(session, page, actor) : undefined;
    return { page, delivery: sent };
  };

  /** A property schema as a test writes it: `"number"`, `{ status: ["Todo", "Done"] }`, `{ relation: db }`. */
  const propertySchema = (name: string, raw: unknown): NotionPropertyRecord => {
    // A database's title property is always `title`; the others get short ids of their own.
    const id = raw === "title" ? "title" : ids.next("notion.propertyId");
    if (typeof raw === "string") return { id, name, type: raw as NotionPropertyType, options: [] };
    const [type, value] = Object.entries(raw as Record<string, unknown>)[0] ?? [];
    if (type === "relation") return { id, name, type: "relation", options: [], relation: String(value) };
    const options = (value as string[]).map((option, at) => ({
      id: ids.next("notion.uuid"),
      name: option,
      color: OPTION_COLORS[at % 10] ?? "default",
    }));
    return { id, name, type: type as NotionPropertyType, options };
  };

  const createDatabase = (session: string, input: DatabaseInput, actor = store.owner.id) => {
    const properties = Object.entries(input.properties).map(([name, raw]) => propertySchema(name, raw));
    if (properties.filter((property) => property.type === "title").length !== 1)
      throw new ProtocolError("invalid_argument", "A database needs exactly one title property");
    const now = clock();
    const id = ids.next("notion.uuid");
    const database = store.databases.add(
      id,
      {
        id,
        dataSource: ids.next("notion.uuid"),
        parent: parentOf(input.parent),
        title: input.title,
        properties,
        connections: [...(input.connections ?? [])],
        createdBy: actor,
        createdAt: now,
        lastEditedAt: now,
        inTrash: false,
      },
      session,
    );
    for (const row of input.rows ?? []) addRow(session, database, row, actor, { announce: false });
    return database;
  };

  const addRow = (
    session: string,
    database: NotionDatabaseRecord,
    values: Record<string, PlainValue>,
    actor: string,
    options: { announce: boolean },
  ) => {
    const parent: NotionParent = { type: "database_id", id: database.id, dataSource: database.dataSource };
    const properties: Record<string, NotionValue> = {};
    for (const [name, value] of Object.entries(values)) {
      const property = database.properties.find((candidate) => candidate.name === name);
      if (!property)
        throw new ProtocolError(
          "invalid_argument",
          `${database.title} has no property "${name}". Its properties: ${database.properties.map((p) => p.name).join(", ")}`,
        );
      properties[name] = fromPlain(property, value);
    }
    addOptions(database.properties, properties);
    const page = makePage(session, parent, properties, actor);
    return { page, delivery: options.announce ? announcePage(session, page, actor) : undefined };
  };

  /** Rows of a database whose properties have these plain values. */
  const rows = (database: NotionDatabaseRecord, filter: Record<string, PlainValue> = {}) =>
    store
      .childPages(database.id)
      .filter((row) =>
        Object.entries(filter).every(
          ([name, wanted]) => JSON.stringify(toPlain(row.properties[name])) === JSON.stringify(wanted),
        ),
      );

  // --- Comments -------------------------------------------------------------------------------

  const addComment = (session: string, discussion: NotionDiscussionRecord, rich: RichTextItem[], actor: string) => {
    if (rich.length === 0 || plainText(rich).trim() === "")
      throw invalid("body failed validation: rich_text should not be empty");
    const now = clock();
    const id = ids.next("notion.uuid");
    const comment = store.comments.add(
      id,
      {
        id,
        discussion: discussion.id,
        page: discussion.page,
        rich,
        createdBy: actor,
        createdAt: now,
        lastEditedAt: now,
        delivery: undefined,
      },
      session,
    );
    const page = store.page(discussion.page);
    comment.delivery = emit(session, page, "comment.created", (eventId) =>
      payloads.commentCreated(eventId, now, [author(actor)], {
        id: comment.id,
        page: page.id,
        discussion: discussion.id,
        parent: discussion.block === null ? { id: page.id, type: "page" } : { id: discussion.block, type: "block" },
      }),
    );
    return comment;
  };

  const startDiscussion = (
    session: string,
    page: NotionPageRecord,
    block: NotionBlockRecord | undefined,
    rich: RichTextItem[],
    actor: string,
  ) => {
    const id = ids.next("notion.uuid");
    const discussion = store.discussions.add(
      id,
      {
        id,
        page: page.id,
        block: block?.id ?? null,
        anchor: block ? blockText(block) : null,
        resolved: false,
        createdAt: clock(),
      },
      session,
    );
    return addComment(session, discussion, rich, actor);
  };

  /** A comment changed or went away: `comment.updated` or `comment.deleted`. */
  const commentEvent = (
    session: string,
    comment: NotionCommentRecord,
    type: "comment.updated" | "comment.deleted",
    actor: string,
  ) => {
    const discussion = store.discussion(comment.discussion);
    const page = store.page(comment.page);
    return emit(session, page, type, (id) =>
      payloads.commentCreated(
        id,
        clock(),
        [author(actor)],
        {
          id: comment.id,
          page: page.id,
          discussion: discussion.id,
          parent: discussion.block === null ? { id: page.id, type: "page" } : { id: discussion.block, type: "block" },
        },
        type,
      ),
    );
  };

  return {
    ...reads,
    store,
    objects,
    links,
    visiblePage,
    visibleDatabase,
    visibleBlock,
    toPlain,
    fromRequest,
    propertyNamed,
    schemaOf,
    richFromRequest,
    rows,
    pendingContent: (session: string) =>
      [...pendingContent.entries()].filter(([, batch]) => batch.session === session).map(([page]) => store.page(page)),
    setContentDelay: (session: string, ms: number) => contentDelay.set(session, ms),
    forgetSession: (session: string) => {
      contentDelay.delete(session);
      for (const [page, batch] of pendingContent) if (batch.session === session) pendingContent.delete(page);
    },

    // People
    createUser(
      session: string,
      input: { name: string; id?: string | undefined; email?: string | undefined; avatarUrl?: string | undefined },
    ) {
      if (store.users.list(session).some((user) => user.name.toLowerCase() === input.name.toLowerCase()))
        throw new ProtocolError("invalid_argument", `There is already a person "${input.name}" in this session`);
      const id = input.id === undefined ? ids.next("notion.uuid") : ids.reserve("notion.uuid", input.id);
      return store.users.add(
        id,
        {
          id,
          name: input.name,
          email: input.email ?? `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@acme.example`,
          avatarUrl: input.avatarUrl ?? null,
          fixedId: input.id !== undefined,
        } satisfies NotionUserRecord,
        session,
      );
    },

    // Pages and databases, for seed data and for people
    createPage,
    createDatabase,
    addRow,
    setProperties,
    fromPlain,
    edit(
      session: string,
      page: NotionPageRecord,
      change: { append?: string | unknown[] | undefined; replace?: string | unknown[] | undefined },
      actor: string,
    ) {
      if (change.replace !== undefined) {
        const removed = childrenOf(page.children);
        for (const block of removed) block.inTrash = true;
        page.children = [];
        contentUpdated(
          session,
          page,
          removed.map((block) => block.id),
          actor,
        );
        append(session, { page }, change.replace, actor);
      }
      if (change.append !== undefined) append(session, { page }, change.append, actor);
      touch(page, actor);
    },
    rename(session: string, page: NotionPageRecord, title: string, actor: string) {
      const property = schemaOf(page).find((candidate) => candidate.type === "title") as NotionPropertyRecord;
      return setProperties(session, page, { [property.name]: { type: "title", rich: [textItem(title)] } }, actor);
    },
    /** A person mentions the integration in the page body: in the block with this text, or a new paragraph. */
    mention(session: string, page: NotionPageRecord, inBlock: TextPattern | undefined, actor: string) {
      const mention = userMention(store.bot.id, store.bot.name);
      if (inBlock === undefined) {
        append(session, { page }, [{ type: "paragraph", paragraph: { rich_text: [] } }], actor);
        const last = store.block(page.children.at(-1) as string);
        last.data = { ...last.data, rich_text: [mention] };
        return;
      }
      const block = blockWith(page, inBlock);
      const rich = (block.data.rich_text as RichTextItem[] | undefined) ?? [];
      block.data = { ...block.data, rich_text: [...rich, textItem(" "), mention] };
      block.lastEditedAt = clock();
      block.lastEditedBy = actor;
      touch(page, actor);
      contentUpdated(session, page, [block.id], actor);
    },
    connect(page: { connections: string[] }) {
      if (!page.connections.includes(store.bot.id)) page.connections.push(store.bot.id);
    },
    disconnect(page: { connections: string[] }) {
      page.connections = page.connections.filter((id) => id !== store.bot.id);
    },

    // Blocks, for the integration
    append,
    updateBlock,
    removeBlock,
    updatePage(
      session: string,
      page: NotionPageRecord,
      input: { properties?: Record<string, unknown>; in_trash?: boolean; archived?: boolean; icon?: unknown },
      actor: string,
    ) {
      if (input.properties) {
        const values = Object.fromEntries(
          Object.entries(input.properties).map(([name, raw]) => {
            const property = propertyNamed(page, name);
            return [property.name, fromRequest(property, raw)];
          }),
        );
        setProperties(session, page, values, actor);
      }
      if (input.in_trash !== undefined || input.archived !== undefined)
        page.inTrash = (input.in_trash ?? input.archived) === true;
      const icon = input.icon as { emoji?: unknown } | null | undefined;
      if (icon !== undefined) page.icon = typeof icon?.emoji === "string" ? icon.emoji : null;
      touch(page, actor);
      return page;
    },
    /** `pages.create` for the integration: under a page, or as a row of a data source. */
    createPageAs(
      session: string,
      parent: NotionParent,
      properties: Record<string, unknown>,
      children: unknown[],
      actor: string,
    ) {
      // Properties and children are checked before the page exists, so a refused create leaves nothing behind.
      const values: Record<string, NotionValue> = {};
      for (const [name, raw] of Object.entries(properties)) {
        const property = propertyNamed({ parent }, name);
        values[property.name] = fromRequest(property, raw);
      }
      const drafts = children.map(draftFromRequest);
      addOptions(schemaFor(parent), values);
      const draft = makePage(session, parent, values, actor);
      draft.children = insertBlocks(session, draft, { type: "page_id", id: draft.id }, drafts, actor);
      announcePage(session, draft, actor);
      return draft;
    },

    // Comments
    comment(session: string, page: NotionPageRecord, rich: RichTextItem[], actor: string, anchor?: TextPattern) {
      return startDiscussion(session, page, anchor === undefined ? undefined : blockWith(page, anchor), rich, actor);
    },
    /** `comments.create` for the integration: on a page, a block, or in a discussion. */
    commentAs(
      session: string,
      target: { page?: NotionPageRecord; block?: NotionBlockRecord; discussion?: NotionDiscussionRecord },
      rich: RichTextItem[],
      actor: string,
    ) {
      if (target.discussion) return addComment(session, target.discussion, rich, actor);
      const page = target.page ?? store.page(target.block?.page as string);
      return startDiscussion(session, page, target.block, rich, actor);
    },
    reply: addComment,
    editComment(session: string, comment: NotionCommentRecord, rich: RichTextItem[], actor: string) {
      comment.rich = rich;
      comment.lastEditedAt = clock();
      return commentEvent(session, comment, "comment.updated", actor);
    },
    deleteComment(session: string, comment: NotionCommentRecord, actor: string) {
      const sent = commentEvent(session, comment, "comment.deleted", actor);
      store.comments.remove(comment.id);
      return sent;
    },

    /** The fake holds the truth already: there is nothing to read again. */
    refresh: (_session: string, _about: { page: string } | { discussion: string }) => {},

    // Deliveries
    resend(session: string, id: string, options: { badSignature: boolean }) {
      const secret = options.badSignature ? `secret_${randomToken()}` : context.secret("verificationToken");
      return delivery.again(session, id, {
        sign: signedWith(secret),
        forged: options.badSignature,
      });
    },
    redeliver: (session: string, id: string) => delivery.again(session, id),
    deliveries: (session: string) => delivery.list(session).filter(({ request }) => request.driver === "notion"),
    delivery: (session: string, id: string) => delivery.get(session, id),
    /** The subscription's verification request, as Notion sends it once when a subscription is created. */
    verify(session: string) {
      if (context.webhookUrl === undefined) return undefined;
      const id = ids.next("notion.uuid");
      delivery.enqueue({
        id,
        session,
        driver: "notion",
        type: "verification",
        url: context.webhookUrl,
        body: JSON.stringify({ verification_token: context.secret("verificationToken") }),
        sign: () => ({ "user-agent": "notion-api" }),
        timeoutMs: ACK_WINDOW_MS,
        meta: {
          payload: { verification_token: "[redacted]" },
          entity: { type: "subscription", id: store.bot.subscriptionId },
        },
      });
      return id;
    },
  };
}

export type FakeNotionWorld = ReturnType<typeof createFakeWorld>;
