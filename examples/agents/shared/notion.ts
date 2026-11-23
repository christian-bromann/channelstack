/**
 * What the Notion reference agents do, written once against `@notionhq/client` so each agent
 * behaves the same. Scripted, so tests can rely on it: a mention in a comment is answered in its
 * discussion, and some requests do more (action items appended to the page, an estimate in a
 * row's property). A mention in the page body fills in that block; a new page gets a summary; a
 * row set to "Ready for agent" is done. Events the agent caused itself are ignored.
 */
import type { Client } from "@notionhq/client";

type RichText = Array<{ plain_text: string; type: string; mention?: { type: string; user?: { id: string } } }>;

/** The integration's name, as people mention it. */
const AGENT = process.env.NOTION_BOT_USERNAME ?? "my-agent";

const text = (content: string) => [{ type: "text" as const, text: { content } }];
const plain = (rich: RichText) => rich.map((item) => item.plain_text).join("");
const mentions = (rich: RichText, me: string) =>
  rich.some((item) => item.type === "mention" && item.mention?.user?.id === me) ||
  plain(rich).toLowerCase().includes(`@${AGENT}`);

export function notionAgent(notion: Client) {
  let me: Promise<string> | undefined;
  /** Its own bot user id, asked once. */
  const self = () => (me ??= notion.users.me({}).then((user) => user.id));

  /** A page's text, block by block (one level deep is enough to talk about it). */
  async function pageText(pageId: string): Promise<string[]> {
    const { results } = await notion.blocks.children.list({ block_id: pageId });
    return results.flatMap((block) => {
      const data = (block as Record<string, unknown>)[(block as { type: string }).type] as
        { rich_text?: RichText } | undefined;
      return data?.rich_text ? [plain(data.rich_text)] : [];
    });
  }

  /** What to say to a comment, and what to do first. */
  async function answer(pageId: string, request: string): Promise<string> {
    const lines = (await pageText(pageId)).filter((line) => line.trim() !== "");
    if (/action items/i.test(request)) {
      await notion.blocks.children.append({
        block_id: pageId,
        children: [
          { type: "heading_2", heading_2: { rich_text: text("Action items") } },
          { type: "to_do", to_do: { rich_text: text("Follow up on the notes above"), checked: false } },
        ],
      });
      return "I added action items at the end of the page.";
    }
    if (/\bestimate\b/i.test(request)) {
      await notion.pages.update({ page_id: pageId, properties: { Estimate: { number: 3 } } });
      return "I estimated it at 3 days.";
    }
    if (/summari[sz]e/i.test(request)) return `Summary: ${lines.join("; ") || "the page is empty"}.`;
    if (/what went wrong/i.test(request)) return `From the notes: ${lines.join("; ")}.`;
    if (/should we change/i.test(request))
      return `Change what the notes call out: ${lines.join("; ")}. Fix that first.`;
    return "Hi! I had a look.";
  }

  async function commentCreated(commentId: string, discussionId: string, pageId: string) {
    // A partial comment (only an id) is what an integration without read access gets.
    const comment = (await notion.comments.retrieve({ comment_id: commentId })) as {
      created_by: { id: string };
      rich_text: RichText;
    };
    const myself = await self();
    if (comment.created_by.id === myself || !mentions(comment.rich_text, myself)) return;
    const reply = await answer(pageId, plain(comment.rich_text));
    await notion.comments.create({ discussion_id: discussionId, rich_text: text(reply) });
  }

  /** A mention of the agent in the page body: it writes that block for the person. */
  async function contentUpdated(blockIds: string[]) {
    const myself = await self();
    for (const id of blockIds) {
      const block = (await notion.blocks.retrieve({ block_id: id }).catch(() => undefined)) as
        (Record<string, unknown> & { type: string; in_trash?: boolean }) | undefined;
      const data = block?.[block.type] as { rich_text?: RichText } | undefined;
      if (!block || block.in_trash || !data?.rich_text || !mentions(data.rich_text, myself)) continue;
      await notion.blocks.update({
        block_id: id,
        [block.type]: { rich_text: text("This draft explains what we are building and why.") },
      } as never);
    }
  }

  /** A new page under one the agent watches gets a summary at the end. */
  async function pageCreated(pageId: string) {
    const lines = (await pageText(pageId)).filter((line) => line.trim() !== "");
    await notion.blocks.children.append({
      block_id: pageId,
      children: [
        { type: "heading_2", heading_2: { rich_text: text("Summary") } },
        { type: "paragraph", paragraph: { rich_text: text(lines.join(" ") || "Nothing written yet.") } },
      ],
    });
  }

  /** A row set to "Ready for agent" is picked up and done. */
  async function propertiesUpdated(pageId: string) {
    const page = (await notion.pages.retrieve({ page_id: pageId })) as {
      properties: Record<string, { type: string; status?: { name: string } | null }>;
    };
    const status = Object.entries(page.properties).find(([, value]) => value.type === "status");
    if (status?.[1].status?.name !== "Ready for agent") return;
    await notion.pages.update({ page_id: pageId, properties: { [status[0]]: { status: { name: "Done" } } } });
  }

  /** Events already handled, by id: a retry is the same event again. */
  const handled = new Set<string>();

  return {
    /** Handle one verified event. Answers once the work is done; the caller decides whether to wait. */
    async handle(event: {
      id: string;
      type: string;
      authors?: Array<{ id: string; type: string }>;
      entity: { id: string; type: string };
      data?: { page_id?: string; discussion_id?: string; updated_blocks?: Array<{ id: string }> };
    }): Promise<void> {
      if (handled.has(event.id)) return;
      handled.add(event.id);
      // What the agent did itself comes back as events too.
      const myself = await self();
      if ((event.authors ?? []).every((author) => author.id === myself)) return;
      switch (event.type) {
        case "comment.created":
          if (event.data?.page_id && event.data.discussion_id)
            await commentCreated(event.entity.id, event.data.discussion_id, event.data.page_id);
          return;
        case "page.content_updated":
          await contentUpdated((event.data?.updated_blocks ?? []).map((block) => block.id));
          return;
        case "page.created":
          await pageCreated(event.entity.id);
          return;
        case "page.properties_updated":
          await propertiesUpdated(event.entity.id);
          return;
      }
    },
  };
}
