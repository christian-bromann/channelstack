import type { SlackMessageRecord } from "./world.ts";

/** One line of a transcript, in the shape every channel's transcript has (`api/common.d.ts`). */
export interface TranscriptEntry {
  id: string;
  author: { id: string; name: string; kind: "user" | "app" };
  at: string;
  text: string;
  controls: string[];
  edited: boolean;
  streaming?: "open" | "stopped" | "completed";
  visibleTo?: { id: string; name: string; kind: "user" | "app" };
  depth: number;
}

type Block = {
  type?: string;
  text?: unknown;
  elements?: unknown;
  fields?: unknown;
  label?: unknown;
  placeholder?: unknown;
  accessory?: unknown;
  element?: unknown;
};

const plain = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof (value as { text?: unknown } | null)?.text === "string"
      ? (value as { text: string }).text
      : "";

/** The text a person reads in a block: sections, headers, context, rich text. Layout is not reproduced. */
function blockText(block: Block): string[] {
  const nested = (items: unknown): string[] =>
    Array.isArray(items) ? items.flatMap((item) => blockText(item as Block)) : [];
  switch (block.type) {
    case "section":
      return [plain(block.text), ...(Array.isArray(block.fields) ? block.fields.map(plain) : [])];
    case "header":
    case "markdown":
      return [plain(block.text)];
    case "context":
      return Array.isArray(block.elements) ? block.elements.map(plain) : [];
    case "rich_text":
    case "rich_text_section":
    case "rich_text_list":
    case "rich_text_quote":
    case "rich_text_preformatted":
      return [nested(block.elements).join("")];
    case "text":
      return [plain(block)];
    case "user":
      return [`<@${(block as { user_id?: string }).user_id ?? ""}>`];
    case "input":
      return [plain(block.label)];
    default:
      return [];
  }
}

/** The labels of what a person can press or choose in a block: buttons, and menus by their placeholder. */
function blockControls(block: Block): string[] {
  const control = (element: Block): string[] => {
    if (element.type === "button") return [plain(element.text)];
    if (typeof element.type === "string" && element.type.endsWith("select")) return [plain(element.placeholder)];
    return [];
  };
  const elements = block.type === "actions" && Array.isArray(block.elements) ? (block.elements as Block[]) : [];
  const accessory = typeof block.accessory === "object" && block.accessory !== null ? [block.accessory as Block] : [];
  return [...elements, ...accessory].flatMap(control).filter((label) => label !== "");
}

/**
 * Slack state reduced to what a person would read: edits applied, deleted messages gone, a stream
 * as one message, ephemeral messages only for their recipient, mentions as names, and the text
 * and button labels of blocks. Text matchers and the UI read this view.
 */
export function renderTranscript(
  messages: readonly SlackMessageRecord[],
  options: {
    /** Who is reading. Without one, ephemeral messages are left out. */
    viewer: string | undefined;
    principal(userId: string): { id: string; name: string; kind: "user" | "app" };
  },
): { entries: TranscriptEntry[]; text: string } {
  const named = (text: string) =>
    text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${options.principal(id).name}`);
  const entries = messages
    .filter((message) => message.ephemeralFor === undefined || message.ephemeralFor === options.viewer)
    .map((message): TranscriptEntry => {
      const blocks = message.blocks as Block[];
      const fromBlocks = blocks.flatMap(blockText).filter((line) => line !== "");
      return {
        id: message.ts,
        author: options.principal(message.user),
        at: new Date(Number(message.ts.split(".")[0]) * 1000).toISOString(),
        // A message's text is what Slack shows when it has no blocks; with blocks, people read the blocks.
        text: named(message.text !== "" ? message.text : fromBlocks.join("\n")),
        controls: blocks.flatMap(blockControls),
        edited: message.edited !== undefined,
        ...(message.stream === undefined ? {} : { streaming: message.stream.state }),
        ...(message.ephemeralFor === undefined ? {} : { visibleTo: options.principal(message.ephemeralFor) }),
        depth: message.threadTs === undefined ? 0 : 1,
      };
    });
  // One line per entry, replies indented under their thread: what `toString()` prints and snapshots keep.
  const text = entries
    .map((entry) => {
      const marks = [
        entry.edited ? "edited" : "",
        entry.streaming === "open" ? "streaming" : "",
        entry.visibleTo ? `only ${entry.visibleTo.name} sees this` : "",
      ]
        .filter((mark) => mark !== "")
        .join(", ");
      const controls = entry.controls.map((control) => ` [${control}]`).join("");
      return `${"  ".repeat(entry.depth)}${entry.author.name}: ${entry.text}${controls}${marks === "" ? "" : ` (${marks})`}`;
    })
    .join("\n");
  return { entries, text };
}
