import { randomString } from "../src/core/secrets/index.ts";

/**
 * A stand-in for real Notion's REST API in unit tests of live mode: a workspace in memory that
 * answers the calls the live backend makes, in Notion's shapes, and records each with whose token
 * made it. As found against the sandbox (decision 0015): every token is a bot; a personal access
 * token's is owned by its person, whom its comments are by, while its pages are by the token's
 * bot. The integration sees only what is under the page it is connected to. `agentReplies` adds
 * the integration's comment, as the agent would.
 */
export interface NotionStub {
  readonly url: string;
  fetch: typeof fetch;
  readonly workspace: string;
  readonly integration: { token: string; botId: string };
  /** The page the integration is connected to. */
  readonly root: string;
  person(name: string, options?: { workspace?: string }): { token: string; userId: string; botId: string };
  readonly calls: Array<{ method: string; path: string; as: string }>;
  agentReplies(discussion: string, text: string): void;
  page(id: string): { id: string; title: string; parent: string | undefined; inTrash: boolean } | undefined;
  commentsOn(page: string): Array<{ id: string; discussion: string; text: string; by: string }>;
}

const hex = "0123456789abcdef";
const uuid = () =>
  `${randomString(8, hex)}-${randomString(4, hex)}-4${randomString(3, hex)}-a${randomString(3, hex)}-${randomString(12, hex)}`;

interface Who {
  name: string;
  botId: string;
  person: string | undefined;
  workspace: string;
}
interface Page {
  id: string;
  parent: string | undefined;
  title: string;
  createdBy: string;
  inTrash: boolean;
  children: string[];
}
interface Block {
  id: string;
  page: string;
  parent: string;
  type: string;
  data: Record<string, unknown>;
  children: string[];
  inTrash: boolean;
}
interface Comment {
  id: string;
  discussion: string;
  parent: { type: "page_id" | "block_id"; id: string };
  rich: Array<Record<string, unknown>>;
  by: string;
  at: string;
}

export function notionStub(options: { workspace?: string } = {}): NotionStub {
  const workspace = options.workspace ?? uuid();
  const integration = { token: `ntn_${randomString(40, hex)}`, botId: uuid() };
  const root = uuid();
  const tokens = new Map<string, Who>([
    [integration.token, { name: "robin", botId: integration.botId, person: undefined, workspace }],
  ]);
  const names = new Map<string, { type: "person" | "bot"; name: string }>([
    [integration.botId, { type: "bot", name: "robin" }],
  ]);
  const pages = new Map<string, Page>([
    [root, { id: root, parent: undefined, title: "Live tests", createdBy: uuid(), inTrash: false, children: [] }],
  ]);
  const blocks = new Map<string, Block>();
  const comments: Comment[] = [];
  const calls: NotionStub["calls"] = [];
  const now = () => new Date().toISOString();

  const ok = (body: unknown) => Response.json(body);
  const refuse = (status: number, code: string, message: string) =>
    Response.json({ object: "error", status, code, message }, { status });

  /** Whether the integration sees a page: it is the integration's page, or under it. */
  const seenByIntegration = (id: string | undefined): boolean => {
    if (id === undefined) return false;
    if (id === root) return true;
    return seenByIntegration(pages.get(id)?.parent ?? blocks.get(id)?.page);
  };
  const visible = (who: Who, id: string) => who.person !== undefined || seenByIntegration(id);
  const plain = (rich: Array<Record<string, unknown>>) =>
    rich.map((item) => {
      const mention = item.mention as { user?: { id: string } } | undefined;
      if (mention?.user) return `@${names.get(mention.user.id)?.name ?? "someone"}`;
      return (item.text as { content: string } | undefined)?.content ?? "";
    });
  /** A mention as Notion answers it: a bot's user filled in, a person's by id. */
  const mentionOut = (mention: unknown) => {
    const id = (mention as { user?: { id: string } } | undefined)?.user?.id;
    const user = id === undefined ? undefined : names.get(id);
    return id === undefined || user?.type !== "bot"
      ? mention
      : { type: "user", user: { object: "user", id, name: user.name, avatar_url: null, type: "bot", bot: {} } };
  };
  const richOut = (rich: Array<Record<string, unknown>>) =>
    rich.map((item, at) => ({
      ...item,
      ...(item.mention === undefined ? {} : { mention: mentionOut(item.mention) }),
      annotations: item.annotations ?? {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
      plain_text: plain(rich)[at],
      href: null,
    }));
  const pageOut = (page: Page) => ({
    object: "page",
    id: page.id,
    parent:
      page.parent === undefined ? { type: "workspace", workspace: true } : { type: "page_id", page_id: page.parent },
    properties: {
      title: {
        id: "title",
        type: "title",
        title: richOut([{ type: "text", text: { content: page.title, link: null } }]),
      },
    },
    icon: null,
    created_by: { object: "user", id: page.createdBy },
    last_edited_by: { object: "user", id: page.createdBy },
    created_time: now(),
    last_edited_time: now(),
    in_trash: page.inTrash,
    archived: page.inTrash,
  });
  const blockOut = (block: Block) => ({
    object: "block",
    id: block.id,
    type: block.type,
    parent:
      block.parent === block.page
        ? { type: "page_id", page_id: block.page }
        : { type: "block_id", block_id: block.parent },
    has_children: block.children.length > 0,
    created_by: { object: "user", id: integration.botId },
    last_edited_by: { object: "user", id: integration.botId },
    created_time: now(),
    last_edited_time: now(),
    in_trash: block.inTrash,
    // Notion answers rich text complete: each item with its plain text and marks.
    [block.type]:
      block.type === "child_page"
        ? { title: pages.get(block.id)?.title ?? "" }
        : Array.isArray(block.data.rich_text)
          ? { ...block.data, rich_text: richOut(block.data.rich_text as Array<Record<string, unknown>>) }
          : block.data,
  });
  const commentOut = (comment: Comment) => ({
    object: "comment",
    id: comment.id,
    discussion_id: comment.discussion,
    parent:
      comment.parent.type === "page_id"
        ? { type: "page_id", page_id: comment.parent.id }
        : { type: "block_id", block_id: comment.parent.id },
    rich_text: richOut(comment.rich),
    created_by: { object: "user", id: comment.by },
    created_time: comment.at,
    last_edited_time: comment.at,
  });
  const list = (results: unknown[]) => ({ object: "list", results, has_more: false, next_cursor: null });

  const addBlocks = (page: string, parent: string, raw: Array<Record<string, unknown>>): string[] =>
    raw.map((input) => {
      const type = input.type as string;
      const { children, ...data } = (input[type] as Record<string, unknown>) ?? {};
      const block: Block = { id: uuid(), page, parent, type, data, children: [], inTrash: false };
      blocks.set(block.id, block);
      block.children = addBlocks(page, block.id, (children as Array<Record<string, unknown>> | undefined) ?? []);
      return block.id;
    });

  const handle = (
    who: Who,
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
  ): Response => {
    const [resource, id, sub] = path.split("/");
    if (method === "GET" && resource === "users" && id === "me") {
      return ok({
        object: "user",
        id: who.botId,
        name: who.name,
        type: "bot",
        bot: {
          owner:
            who.person === undefined
              ? { type: "workspace", workspace: true }
              : { type: "user", user: { object: "user", id: who.person, type: "person" } },
          workspace_id: who.workspace,
          workspace_name: "Stub",
        },
      });
    }
    if (method === "GET" && resource === "users" && id) {
      const user = names.get(id);
      return user
        ? ok({ object: "user", id, type: user.type, name: user.name })
        : refuse(404, "object_not_found", `Could not find user with ID: ${id}.`);
    }
    if (method === "POST" && resource === "search") {
      const queried = typeof body.query === "string" ? body.query : "";
      const found = [...pages.values()].filter(
        (page) => !page.inTrash && visible(who, page.id) && page.title.includes(queried),
      );
      return ok(list(found.map(pageOut)));
    }
    if (resource === "pages" && method === "POST") {
      const parent = (body.parent as { page_id?: string }).page_id as string;
      if (!pages.has(parent) || !visible(who, parent))
        return refuse(404, "object_not_found", `Could not find page with ID: ${parent}.`);
      const title =
        (body.properties as { title: { title: Array<{ text: { content: string } }> } }).title.title[0]?.text.content ??
        "";
      const page: Page = { id: uuid(), parent, title, createdBy: who.botId, inTrash: false, children: [] };
      pages.set(page.id, page);
      const above = pages.get(parent) as Page;
      blocks.set(page.id, {
        id: page.id,
        page: parent,
        parent,
        type: "child_page",
        data: {},
        children: [],
        inTrash: false,
      });
      above.children.push(page.id);
      page.children = addBlocks(page.id, page.id, (body.children as Array<Record<string, unknown>> | undefined) ?? []);
      return ok(pageOut(page));
    }
    if (resource === "pages" && id) {
      const page = pages.get(id);
      if (!page || !visible(who, id)) return refuse(404, "object_not_found", `Could not find page with ID: ${id}.`);
      if (method === "PATCH") {
        if (body.in_trash !== undefined) page.inTrash = body.in_trash === true;
        const title = (body.properties as { title?: { title: Array<{ text: { content: string } }> } } | undefined)
          ?.title;
        if (title) page.title = title.title[0]?.text.content ?? "";
      }
      return ok(pageOut(page));
    }
    if (resource === "blocks" && id) {
      const page = pages.get(id);
      const block = blocks.get(id);
      if ((!page && !block) || !visible(who, id))
        return refuse(404, "object_not_found", `Could not find block with ID: ${id}.`);
      const holder = (page ?? block) as { children: string[] };
      if (sub === "children" && method === "GET") {
        return ok(
          list(
            holder.children
              .map((child) => blocks.get(child) as Block)
              .filter((child) => !child.inTrash)
              .map(blockOut),
          ),
        );
      }
      if (sub === "children" && method === "PATCH") {
        const added = addBlocks(
          page ? page.id : (block as Block).page,
          id,
          body.children as Array<Record<string, unknown>>,
        );
        holder.children.push(...added);
        return ok(list(added.map((child) => blockOut(blocks.get(child) as Block))));
      }
      if (block && method === "DELETE") {
        block.inTrash = true;
        return ok(blockOut(block));
      }
      if (block && method === "PATCH") {
        block.data = { ...block.data, ...(body[block.type] as Record<string, unknown>) };
        return ok(blockOut(block));
      }
    }
    if (resource === "comments" && method === "GET") {
      const target = query.get("block_id") as string;
      if (!visible(who, target)) return refuse(404, "object_not_found", `Could not find block with ID: ${target}.`);
      return ok(list(comments.filter((comment) => comment.parent.id === target).map(commentOut)));
    }
    if (resource === "comments" && method === "POST") {
      const by = who.person ?? who.botId;
      const rich = body.rich_text as Array<Record<string, unknown>>;
      if (typeof body.discussion_id === "string") {
        const first = comments.find((comment) => comment.discussion === body.discussion_id);
        if (!first) return refuse(404, "object_not_found", "Could not find discussion.");
        const comment: Comment = {
          id: uuid(),
          discussion: first.discussion,
          parent: first.parent,
          rich,
          by,
          at: now(),
        };
        comments.push(comment);
        return ok(commentOut(comment));
      }
      const parent = body.parent as { page_id?: string; block_id?: string };
      const target = parent.page_id ?? (parent.block_id as string);
      if (!visible(who, target)) return refuse(404, "object_not_found", `Could not find page with ID: ${target}.`);
      const comment: Comment = {
        id: uuid(),
        discussion: uuid(),
        parent: parent.page_id ? { type: "page_id", id: target } : { type: "block_id", id: target },
        rich,
        by,
        at: now(),
      };
      comments.push(comment);
      return ok(commentOut(comment));
    }
    if (resource === "comments" && id) {
      const at = comments.findIndex((comment) => comment.id === id);
      const comment = comments[at];
      if (!comment) return refuse(404, "object_not_found", `Could not find comment with ID: ${id}.`);
      if (comment.by !== (who.person ?? who.botId))
        return refuse(403, "restricted_resource", "Only its author can change a comment.");
      if (method === "PATCH") comment.rich = body.rich_text as Array<Record<string, unknown>>;
      if (method === "DELETE") comments.splice(at, 1);
      return ok(commentOut(comment));
    }
    return refuse(400, "invalid_request_url", `The stub doesn't answer ${method} /${path}`);
  };

  const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const who = tokens.get(token);
    const path = url.pathname.replace(/^\/v1\//, "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      as: who?.person === undefined ? (who ? "integration" : "nobody") : who.name,
    });
    if (!who) return refuse(401, "unauthorized", "API token is invalid.");
    const body =
      typeof init?.body === "string" && init.body !== "" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    return handle(who, init?.method ?? "GET", path, url.searchParams, body);
  }) as typeof fetch;

  return {
    url: "https://notion.stub",
    workspace,
    integration,
    root,
    calls,
    fetch: stubFetch,
    person(name, personOptions = {}) {
      const token = `ntn_${randomString(40, hex)}`;
      const userId = uuid();
      const botId = uuid();
      tokens.set(token, { name, botId, person: userId, workspace: personOptions.workspace ?? workspace });
      names.set(userId, { type: "person", name: `${name.toLowerCase()}@example.com` });
      names.set(botId, { type: "bot", name: "people" });
      return { token, userId, botId };
    },
    agentReplies(discussion, text) {
      const first = comments.find((comment) => comment.discussion === discussion);
      if (!first) throw new Error(`No discussion ${discussion}`);
      comments.push({
        id: uuid(),
        discussion,
        parent: first.parent,
        rich: [{ type: "text", text: { content: text, link: null } }],
        by: integration.botId,
        at: now(),
      });
    },
    page(id) {
      const page = pages.get(id);
      return page && { id: page.id, title: page.title, parent: page.parent, inTrash: page.inTrash };
    },
    commentsOn(page) {
      return comments
        .filter((comment) => comment.parent.id === page)
        .map((comment) => ({
          id: comment.id,
          discussion: comment.discussion,
          text: plain(comment.rich).join(""),
          by: comment.by,
        }));
    },
  };
}
