/**
 * Reading a modal the way a person does: its inputs by their labels, what is filled in, and the
 * `state.values` Slack sends when it is submitted.
 */
import { type Block, plain, selectOptions } from "./blocks.ts";

/** One input of a view: where it sits, what the person calls it, and its element. */
export interface ViewInput {
  blockId: string;
  actionId: string;
  label: string;
  optional: boolean;
  element: Block;
}

/** What one input holds, in the shape of `view.state.values[block_id][action_id]`. */
export type ViewEntry = Record<string, unknown> & { type: string };

type Option = { text: unknown; value: string };

/** The state key each kind of element keeps its value under, and whether it holds several. */
const HOLDS: Readonly<Record<string, { key: string; many: boolean; options: boolean }>> = {
  plain_text_input: { key: "value", many: false, options: false },
  email_text_input: { key: "value", many: false, options: false },
  url_text_input: { key: "value", many: false, options: false },
  number_input: { key: "value", many: false, options: false },
  datepicker: { key: "selected_date", many: false, options: false },
  timepicker: { key: "selected_time", many: false, options: false },
  users_select: { key: "selected_user", many: false, options: false },
  conversations_select: { key: "selected_conversation", many: false, options: false },
  channels_select: { key: "selected_channel", many: false, options: false },
  multi_users_select: { key: "selected_users", many: true, options: false },
  multi_conversations_select: { key: "selected_conversations", many: true, options: false },
  multi_channels_select: { key: "selected_channels", many: true, options: false },
  static_select: { key: "selected_option", many: false, options: true },
  external_select: { key: "selected_option", many: false, options: true },
  radio_buttons: { key: "selected_option", many: false, options: true },
  multi_static_select: { key: "selected_options", many: true, options: true },
  multi_external_select: { key: "selected_options", many: true, options: true },
  checkboxes: { key: "selected_options", many: true, options: true },
};

/** The inputs of a view, in order. Blocks need their ids filled in first (`identified`). */
export function viewInputs(blocks: readonly unknown[]): ViewInput[] {
  return (blocks as Block[]).flatMap((block) => {
    const element = block.element as Block | undefined;
    if (block.type !== "input" || typeof element !== "object" || element === null) return [];
    return [
      {
        blockId: block.block_id ?? "",
        actionId: element.action_id ?? "",
        label: plain(block.label),
        optional: (block as { optional?: unknown }).optional === true,
        element,
      },
    ];
  });
}

/** What an input holds before the person touches it: the element's `initial_*` value, or nothing. */
export function initialEntry(element: Block): ViewEntry {
  const type = String(element.type);
  const holds = HOLDS[type];
  if (!holds) return { type };
  const initial = (element as Record<string, unknown>)[`initial_${holds.key.replace(/^selected_/, "")}`];
  return { type, [holds.key]: initial ?? (holds.many ? [] : null) };
}

/**
 * What an input holds after the person filled it in. Options are chosen by their text or their
 * value. Returns a sentence instead when the input offers no such option.
 */
export function filledEntry(input: ViewInput, raw: string | readonly string[]): ViewEntry | string {
  const type = String(input.element.type);
  const holds = HOLDS[type];
  if (!holds) return `"${input.label}" is a ${type}, which can't be filled in`;
  const wanted = typeof raw === "string" ? [raw] : [...raw];
  if (!holds.many && wanted.length !== 1) return `"${input.label}" takes one value`;
  if (!holds.options) return { type, [holds.key]: holds.many ? wanted : wanted[0] };
  const offered = selectOptions(input.element) as Option[];
  const chosen: Option[] = [];
  for (const value of wanted) {
    const option = offered.find((candidate) => plain(candidate.text) === value || candidate.value === value);
    if (!option) {
      return `"${input.label}" has no option ${JSON.stringify(value)}. It offers: ${offered.map((candidate) => plain(candidate.text)).join(", ")}`;
    }
    chosen.push(option);
  }
  return { type, [holds.key]: holds.many ? chosen : chosen[0] };
}

/** What a person sees in an input: its text, the chosen option's text, or a list of them. Nothing when empty. */
export function shownValue(entry: ViewEntry): string | string[] | undefined {
  const holds = HOLDS[entry.type];
  if (!holds) return undefined;
  const text = (value: unknown) => (holds.options ? plain((value as Option).text) : String(value));
  const held = entry[holds.key];
  if (holds.many) return Array.isArray(held) ? held.map(text) : [];
  return held === null || held === undefined || held === "" ? undefined : text(held);
}

/** Is an input empty, the way the client decides whether a required input may be submitted? */
export const isEmpty = (entry: ViewEntry): boolean => {
  const shown = shownValue(entry);
  return shown === undefined || (Array.isArray(shown) && shown.length === 0);
};
