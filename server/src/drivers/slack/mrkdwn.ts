/**
 * Slack mrkdwn → the `rich_text` block Slack makes of a message sent with text and no blocks (#45).
 *
 * The rules are Slack's, as recorded from real Slack (`mrkdwn.fixtures.json`), quirks included:
 * - `*bold*`, `_italic_`, `~strike~` and `` `code` `` style text. An opening marker has no letter,
 *   digit or the same marker before it, and no space or the same marker after it; a closing one
 *   has no letter or digit after it. Markers pair like brackets, innermost first, within a line;
 *   a pair inside the same style splits the text without changing its style. `<…>` doesn't hide
 *   a marker: a pair that closes inside one leaves it as text. Code holds links and mentions, but
 *   no styles or emoji.
 * - `<@U…>`, `<#C…>`, `<!here>`, `<!subteam^S…>`, `<!date^…^…>` and `<https://…|label>` are their
 *   elements; a label is styled like text. Anything else in `<…>` (a space, nothing after `@`, a
 *   malformed date) stays as typed. Bare URLs and email addresses are links.
 * - `:name:` is an emoji (its code points from the emoji data Slack uses, none for a name it
 *   doesn't know), `:name::skin-tone-N:` one with a skin tone; a name of digits only isn't one.
 * - ```` ```…``` ```` is a preformatted section, and lines starting with `>` a quote (`>` alone is
 *   text). A single newline next to either is dropped; a blank line is kept.
 * - `&amp;`, `&lt;` and `&gt;` are unescaped.
 */
import emojiData from "emoji-datasource" with { type: "json" };

import { unescapeMrkdwn } from "./mentions.ts";

type Element = Record<string, unknown>;
type StyleName = "bold" | "italic" | "strike" | "code";
type Style = ReadonlySet<StyleName>;

const MARKERS: Readonly<Record<string, StyleName>> = { "*": "bold", _: "italic", "~": "strike", "`": "code" };
/** The order Slack writes a style's keys in. */
const STYLE_ORDER: readonly StyleName[] = ["bold", "italic", "strike", "code"];
const NO_STYLE: Style = new Set();

interface EmojiEntry {
  unicode: string;
  /** Code points per skin tone, by the tone's own code point (`1F3FB` … `1F3FF`). */
  skins?: Readonly<Record<string, string>>;
}

let emojiByName: Map<string, EmojiEntry> | undefined;
/** The emoji Slack knows, by every short name it answers to. The index is built on first use. */
function emoji(name: string): EmojiEntry | undefined {
  if (!emojiByName) {
    emojiByName = new Map();
    for (const entry of emojiData as Array<{
      unified: string;
      short_names: string[];
      skin_variations?: Record<string, { unified: string }>;
    }>) {
      const skins = entry.skin_variations
        ? Object.fromEntries(
            Object.entries(entry.skin_variations).map(([tone, variant]) => [tone, variant.unified.toLowerCase()]),
          )
        : undefined;
      const value: EmojiEntry = { unicode: entry.unified.toLowerCase(), ...(skins ? { skins } : {}) };
      for (const short of entry.short_names) emojiByName.set(short, value);
    }
  }
  return emojiByName.get(name);
}

const styleObject = (style: Style) =>
  style.size === 0 ? {} : { style: Object.fromEntries(STYLE_ORDER.filter((s) => style.has(s)).map((s) => [s, true])) };

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Collects elements, merging plain text of one style into one text element. */
class Elements {
  readonly list: Element[] = [];
  private buffer = "";
  private style: Style = NO_STYLE;
  text(text: string, style: Style) {
    if (style !== this.style) this.flush();
    this.style = style;
    this.buffer += text;
  }
  push(...elements: Element[]) {
    this.flush();
    this.list.push(...elements);
  }
  flush() {
    if (this.buffer) this.list.push({ type: "text", text: unescapeMrkdwn(this.buffer), ...styleObject(this.style) });
    this.buffer = "";
  }
  done(): Element[] {
    this.flush();
    return this.list;
  }
}

const DATE = /^!date\^(\d+)\^([^^]+)(?:\^(.+))?$/;

/** One `<…>`'s elements: a mention, a channel, a special mention, a date or a link. Undefined: it stays text. */
function entity(inner: string, style: Style): Element[] | undefined {
  const bar = inner.indexOf("|");
  const head = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? undefined : inner.slice(bar + 1);
  if (head === "" || /\s/.test(head)) return undefined;
  const styled = styleObject(style);
  const sigil = head[0];
  const id = head.slice(1);
  if (sigil === "@") return id ? [{ type: "user", user_id: id, ...styled }] : undefined;
  if (sigil === "#") return id ? [{ type: "channel", channel_id: id, ...styled }] : undefined;
  if (sigil === "!") {
    if (id.startsWith("date^")) {
      const date = DATE.exec(head);
      if (!date) return undefined;
      const [, timestamp, format, url] = date;
      return [
        {
          type: "date",
          timestamp: Number(timestamp),
          format,
          ...(url ? { url } : {}),
          ...(label === undefined ? {} : { fallback: unescapeMrkdwn(label) }),
          ...styled,
        },
      ];
    }
    if (id.startsWith("subteam^")) {
      const group = id.slice("subteam^".length);
      return group ? [{ type: "usergroup", usergroup_id: group, ...styled }] : undefined;
    }
    // Slack keeps whatever follows the `!`, a label included (`<!here|here>` is the range `here|here`).
    return id ? [{ type: "broadcast", range: inner.slice(1), ...styled }] : undefined;
  }
  const url = unescapeMrkdwn(head);
  if (label === undefined || label === "") return [{ type: "link", url, ...styled }];
  // A label is styled like text: each of its runs is a link of its own.
  return inline(label, style).map((element) =>
    element.type === "text"
      ? { type: "link", url, text: element.text, ...(element.style ? { style: element.style } : {}) }
      : element,
  );
}

// Sticky: each is tried at one position (`lastIndex`), without copying the rest of the text.
const ENTITY = /<([^<>]*)>/y;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>]+/y;
const TRAILING_PUNCTUATION = /[.,!?;:)\]'"]+$/;
const EMOJI = /:([A-Za-z0-9_+'-]+):(?::skin-tone-([2-6]):)?/y;
const EMAIL_LOCAL = /[\p{L}\p{N}._%+-]/u;
const EMAIL_DOMAIN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;

/** `pattern`'s match starting exactly at `at`, if any. */
const matchAt = (pattern: RegExp, text: string, at: number) => {
  pattern.lastIndex = at;
  return pattern.exec(text);
};

/** Text with `<…>` entities and nothing else: what code and preformatted sections hold. */
function entitiesOnly(text: string, style: Style): Element[] {
  const out = new Elements();
  let i = 0;
  while (i < text.length) {
    const match = text[i] === "<" ? matchAt(ENTITY, text, i) : null;
    const elements = match ? entity(match[1] as string, style) : undefined;
    if (match && elements) {
      out.push(...elements);
      i += match[0].length;
      continue;
    }
    out.text(text[i] as string, style);
    i++;
  }
  return out.done();
}

/**
 * Where each style marker that opens is closed: markers pair like brackets, per marker, within a
 * line. One pass, so a line of markers that never close costs no more than any other.
 */
function markerPairs(text: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: Record<string, number[]> = { "*": [], _: [], "~": [], "`": [] };
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "\n") {
      for (const stack of Object.values(open)) stack.length = 0;
      continue;
    }
    const stack = open[char];
    if (!stack) continue;
    const before = text[i - 1];
    const after = text[i + 1];
    const last = stack.at(-1);
    if (last !== undefined && i > last + 1 && !isWordChar(after)) {
      pairs.set(stack.pop() as number, i);
      continue;
    }
    if (!isWordChar(before) && before !== char && after !== undefined && !/\s/.test(after) && after !== char) {
      stack.push(i);
    }
  }
  return pairs;
}

/** The email addresses in `text`, by where each starts. Found from each `@`, so it costs one pass. */
function emailsIn(text: string): Map<number, string> {
  const found = new Map<number, string>();
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && EMAIL_LOCAL.test(text[start - 1] as string)) start--;
    while (start < at && !isWordChar(text[start])) start++;
    if (start === at || text[start - 1] === ".") continue;
    const domain = EMAIL_DOMAIN.exec(text.slice(at + 1, at + 256))?.[0];
    if (domain) found.set(start, text.slice(start, at + 1 + domain.length));
  }
  return found;
}

/** A section's or a quote's mrkdwn → its elements, in `base` style (a link label's). */
function inline(text: string, base: Style): Element[] {
  const pairs = markerPairs(text);
  const emails = emailsIn(text);
  const out = new Elements();
  /** The styles open here, each with where it closes; innermost last. */
  const active: Array<{ close: number; style: Style }> = [];
  let style = base;
  let i = 0;
  while (i < text.length) {
    const limit = active.at(-1)?.close ?? text.length;
    if (i === limit) {
      out.flush();
      active.pop();
      style = active.at(-1)?.style ?? base;
      i++;
      continue;
    }
    const char = text[i] as string;
    const before = text[i - 1];
    if (char === "<") {
      const match = matchAt(ENTITY, text, i);
      const elements = match && i + match[0].length <= limit ? entity(match[1] as string, style) : undefined;
      if (match && elements) {
        out.push(...elements);
        i += match[0].length;
        continue;
      }
    }
    const marker = MARKERS[char];
    const close = pairs.get(i);
    if (marker && close !== undefined && close < limit) {
      const styled = new Set(style).add(marker);
      if (marker === "code") {
        out.push(...entitiesOnly(text.slice(i + 1, close), styled));
        i = close + 1;
        continue;
      }
      out.flush();
      active.push({ close, style: styled });
      style = styled;
      i++;
      continue;
    }
    if (char === ":") {
      const match = matchAt(EMOJI, text, i);
      const name = match?.[1];
      if (match && name && !/^\d+$/.test(name) && i + match[0].length <= limit) {
        const known = emoji(name);
        const tone = match[2];
        const skin = tone && known?.skins?.[(0x1f3f9 + Number(tone)).toString(16).toUpperCase()];
        if (tone && !skin) {
          // No skin tone for this one: the tone is an emoji of its own, as written.
          out.push(emojiElement(name, known?.unicode, undefined, style));
          i += name.length + 2;
          continue;
        }
        out.push(emojiElement(name, skin || known?.unicode, tone ? Number(tone) : undefined, style));
        i += match[0].length;
        continue;
      }
    }
    if (!isWordChar(before) && (char === "h" || char === "w")) {
      const url = matchAt(BARE_URL, text, i)?.[0]
        .slice(0, limit - i)
        .replace(TRAILING_PUNCTUATION, "");
      if (url && url !== "www." && !/^https?:\/\/$/.test(url)) {
        out.push(
          url.startsWith("www.")
            ? { type: "link", url: `http://${unescapeMrkdwn(url)}`, text: unescapeMrkdwn(url), ...styleObject(style) }
            : { type: "link", url: unescapeMrkdwn(url), ...styleObject(style) },
        );
        i += url.length;
        continue;
      }
    }
    const email = emails.get(i);
    if (email && i + email.length <= limit) {
      out.push({ type: "link", url: `mailto:${email}`, text: email, ...styleObject(style) });
      i += email.length;
      continue;
    }
    out.text(char, style);
    i++;
  }
  return out.done();
}

const emojiElement = (name: string, unicode: string | undefined, tone: number | undefined, style: Style): Element => ({
  type: "emoji",
  name,
  ...(unicode ? { unicode } : {}),
  ...(tone === undefined ? {} : { skin_tone: tone }),
  ...styleObject(style),
});

/** A single newline next to a quote or a fence goes; a blank line stays. */
const trimEdge = (text: string, start: boolean, end: boolean) => {
  let out = text;
  if (start && out.startsWith("\n") && !out.startsWith("\n\n")) out = out.slice(1);
  if (end && out.endsWith("\n") && !out.endsWith("\n\n")) out = out.slice(0, -1);
  return out;
};

const isQuoteLine = (line: string) => line.startsWith(">") || line.startsWith("&gt;");

/**
 * Text between fences → its sections, and its quotes (runs of lines starting with `>`), with
 * whether the fence after it starts on a quote's line (Slack shows a bordered fence then).
 * `fenceBefore` and `fenceAfter`: whether a fence touches it.
 */
function sectionsAndQuotes(
  text: string,
  fenceBefore: boolean,
  fenceAfter: boolean,
): { elements: Element[]; quotesFence: boolean } {
  const elements: Element[] = [];
  const lines = text.split("\n");
  /** Where each line starts in `text`. */
  const starts: number[] = [];
  for (let k = 0, at = 0; k < lines.length; at += (lines[k] as string).length + 1, k++) starts.push(at);
  let plainFrom = 0;
  let afterQuote = false;
  let quotesFence = false;
  const plain = (to: number, quoteNext: boolean) => {
    const body = trimEdge(text.slice(plainFrom, to), afterQuote || (plainFrom === 0 && fenceBefore), quoteNext);
    if (body !== "") elements.push({ type: "rich_text_section", elements: inline(body, NO_STYLE) });
  };
  let k = 0;
  while (k < lines.length) {
    if (!isQuoteLine(lines[k] as string)) {
      k++;
      continue;
    }
    const first = k;
    while (k < lines.length && isQuoteLine(lines[k] as string)) k++;
    const group = lines.slice(first, k);
    const head = group[0] as string;
    const marker = head.startsWith("&gt;") ? "&gt;" : ">";
    const padded = head.slice(marker.length).startsWith(" ");
    // Slack strips `> ` from the quote's first line, and only `>` from the lines after it.
    const body = [
      head.slice(marker.length + (padded ? 1 : 0)),
      ...group.slice(1).map((line) => line.slice(line.startsWith("&gt;") ? 4 : 1)),
    ].join("\n");
    const onFenceLine = k === lines.length && fenceAfter;
    if (body.trim() === "" && !onFenceLine) continue; // `>` alone is text: it stays in the section around it.
    quotesFence = onFenceLine;
    plain(starts[first] as number, true);
    elements.push({
      type: "rich_text_quote",
      elements: body === "" ? [{ type: "text", text: "" }] : inline(body, NO_STYLE),
      contains_padding: padded,
    });
    plainFrom = k === lines.length ? text.length : (starts[k] as number) - 1;
    afterQuote = true;
  }
  if (plainFrom < text.length) plain(text.length, fenceAfter);
  return { elements, quotesFence };
}

/** The elements of the `rich_text` block Slack makes of `text`. */
export function richTextElements(message: string): Element[] {
  // Slack keeps no spaces at the end of a message (`> ` is `>`).
  const text = message.replace(/[ \t]+$/, "");
  const elements: Element[] = [];
  const fences: Array<{ start: number; end: number; content: string }> = [];
  for (let search = 0; ;) {
    const open = text.indexOf("```", search);
    if (open === -1) break;
    const close = text.indexOf("```", open + 3);
    if (close === -1) break;
    const content = text.slice(open + 3, close).replace(/^\n/, "");
    if (content !== "") fences.push({ start: open, end: close + 3, content });
    search = close + 3;
  }
  let from = 0;
  for (const [n, fence] of fences.entries()) {
    const before = sectionsAndQuotes(text.slice(from, fence.start), n > 0, true);
    elements.push(...before.elements, {
      type: "rich_text_preformatted",
      elements: entitiesOnly(fence.content, NO_STYLE),
      ...(before.quotesFence ? { border: 1 } : {}),
    });
    from = fence.end;
  }
  elements.push(...sectionsAndQuotes(text.slice(from), fences.length > 0, false).elements);
  return elements;
}
