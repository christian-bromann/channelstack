/**
 * Reading Block Kit: the text a person reads in blocks, what they can press or choose, and where
 * a control with a given label or `action_id` is. Transcripts and interactions both read blocks
 * through here.
 */
export type Block = {
  type?: string;
  text?: unknown;
  elements?: unknown;
  fields?: unknown;
  label?: unknown;
  placeholder?: unknown;
  accessory?: unknown;
  element?: unknown;
  block_id?: string;
  action_id?: string;
  value?: unknown;
  options?: unknown;
  option_groups?: unknown;
};

export const plain = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof (value as { text?: unknown } | null)?.text === "string"
      ? (value as { text: string }).text
      : "";

/** The text a person reads in a block: sections, headers, context, rich text. Layout is not reproduced. */
export function blockText(block: Block): string[] {
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
export function blockControls(block: Block): string[] {
  const control = (element: Block): string[] => {
    if (element.type === "button") return [plain(element.text)];
    if (typeof element.type === "string" && element.type.endsWith("select")) return [plain(element.placeholder)];
    return [];
  };
  const elements = block.type === "actions" && Array.isArray(block.elements) ? (block.elements as Block[]) : [];
  const accessory = typeof block.accessory === "object" && block.accessory !== null ? [block.accessory as Block] : [];
  return [...elements, ...accessory].flatMap(control).filter((label) => label !== "");
}

/** The elements of a message's blocks a person can act on, each with the block it sits in. */
function interactiveElements(blocks: readonly unknown[]): Array<{ block: Block; element: Block }> {
  return (blocks as Block[]).flatMap((block) => {
    const elements = block.type === "actions" && Array.isArray(block.elements) ? (block.elements as Block[]) : [];
    const single = [block.accessory, block.type === "input" ? block.element : undefined].filter(
      (element): element is Block => typeof element === "object" && element !== null,
    );
    return [...elements, ...single].map((element) => ({ block, element }));
  });
}

const isSelect = (element: Block) => typeof element.type === "string" && element.type.endsWith("select");

/** The button a person means: by the label they see, or by its `action_id`. */
export function findButton(
  blocks: readonly unknown[],
  wanted: { label?: string | undefined; actionId?: string | undefined; value?: string | undefined },
): { block: Block; element: Block } | undefined {
  return interactiveElements(blocks).find(
    ({ element }) =>
      element.type === "button" &&
      (wanted.label === undefined || plain(element.text) === wanted.label) &&
      (wanted.actionId === undefined || element.action_id === wanted.actionId) &&
      (wanted.value === undefined || element.value === wanted.value),
  );
}

/** The select menu a person means: by its placeholder, by the label of its input block, or by its `action_id`. */
export function findSelect(
  blocks: readonly unknown[],
  wanted: { label?: string | undefined; actionId?: string | undefined },
): { block: Block; element: Block } | undefined {
  return interactiveElements(blocks).find(
    ({ block, element }) =>
      isSelect(element) &&
      (wanted.label === undefined ||
        plain(element.placeholder) === wanted.label ||
        plain(block.label) === wanted.label) &&
      (wanted.actionId === undefined || element.action_id === wanted.actionId),
  );
}

/** A select menu's options, groups flattened: each `{ text, value }` as the app wrote it. */
export function selectOptions(element: Block): Array<{ text: unknown; value: string }> {
  const groups = Array.isArray(element.option_groups)
    ? (element.option_groups as Array<{ options?: unknown }>).flatMap((group) => group.options ?? [])
    : [];
  const options = Array.isArray(element.options) ? element.options : [];
  return [...options, ...groups].filter(
    (option): option is { text: unknown; value: string } => typeof (option as { value?: unknown })?.value === "string",
  );
}

/**
 * Blocks as Slack stores them: every block has a `block_id` and every control an `action_id`.
 * What the app left out is filled in, the way Slack generates them.
 */
export function identified(blocks: readonly unknown[], nextId: () => string): unknown[] {
  const control = (element: unknown): unknown =>
    typeof element === "object" && element !== null && !("action_id" in element) && "type" in element
      ? { ...element, action_id: nextId() }
      : element;
  return blocks.map((raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const block = raw as Block;
    return {
      ...block,
      block_id: block.block_id ?? nextId(),
      ...(block.type === "actions" && Array.isArray(block.elements) ? { elements: block.elements.map(control) } : {}),
      ...(block.type === "input" && block.element !== undefined ? { element: control(block.element) } : {}),
      ...(block.type === "section" && block.accessory !== undefined ? { accessory: control(block.accessory) } : {}),
    };
  });
}
