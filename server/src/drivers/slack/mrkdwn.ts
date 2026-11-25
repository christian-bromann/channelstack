/**
 * Slack mrkdwn → the `rich_text` block Slack makes of a message sent with text and no blocks (#45).
 *
 * The rules are Slack's, as recorded from real Slack (`mrkdwn.fixtures.json`), quirks included:
 * - `*bold*`, `_italic_`, `~strike~` and `` `code` `` style text when the opening marker starts a
 *   word (no letter, digit or the same marker before it, no space or the same marker after it)
 *   and the closing one ends it (no letter or digit after it), on one line. Styles nest; code
 *   holds links and mentions but no styles or emoji.
 * - `<@U…>`, `<#C…>`, `<!here>`, `<!subteam^S…>`, `<!date^…>` and `<https://…|label>` are their
 *   elements; a label is styled like text. Bare URLs and email addresses are links.
 * - `:name:` is an emoji (its code points from the emoji data Slack uses, none for a name it
 *   doesn't know), `:name::skin-tone-N:` one with a skin tone; a name of digits only isn't one.
 * - ```` ```…``` ```` is a preformatted section, and lines starting with `>` a quote. A single
 *   newline next to one is dropped; a blank line is kept.
 * - `&amp;`, `&lt;` and `&gt;` are unescaped.
 */
import emojiData from "emoji-datasource" with { type: "json" };

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
/** The emoji Slack knows, by every short name it answers to. Built on first use. */
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

const unescapeText = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const styleObject = (style: Style) =>
  style.size === 0 ? {} : { style: Object.fromEntries(STYLE_ORDER.filter((s) => style.has(s)).map((s) => [s, true])) };

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Collects elements, merging plain text of one style into one text element. */
class Elements {
  readonly list: Element[] = [];
  private buffer = "";
  private readonly style: Style;
  constructor(style: Style) {
    this.style = style;
  }
  text(text: string) {
    this.buffer += text;
  }
  push(...elements: Element[]) {
    this.flush();
    this.list.push(...elements);
  }
  done(): Element[] {
    this.flush();
    return this.list;
  }
  private flush() {
    if (this.buffer) this.list.push({ type: "text", text: unescapeText(this.buffer), ...styleObject(this.style) });
    this.buffer = "";
  }
}

/** One `<…>`: a mention, a channel, a special mention, a date or a link. */
function entity(inner: string, style: Style): Element[] {
  const bar = inner.indexOf("|");
  const head = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? undefined : inner.slice(bar + 1);
  const styled = styleObject(style);
  if (inner.startsWith("@")) return [{ type: "user", user_id: head.slice(1), ...styled }];
  if (inner.startsWith("#")) return [{ type: "channel", channel_id: head.slice(1), ...styled }];
  if (inner.startsWith("!date^")) {
    const [, timestamp, format, url] = head.split("^");
    return [
      {
        type: "date",
        timestamp: Number(timestamp),
        format,
        ...(url ? { url } : {}),
        ...(label === undefined ? {} : { fallback: unescapeText(label) }),
        ...styled,
      },
    ];
  }
  if (inner.startsWith("!subteam^"))
    return [{ type: "usergroup", usergroup_id: head.slice("!subteam^".length), ...styled }];
  // Slack keeps whatever follows the `!`, a label included (`<!here|here>` is the range `here|here`).
  if (inner.startsWith("!")) return [{ type: "broadcast", range: inner.slice(1), ...styled }];
  const url = unescapeText(head);
  if (label === undefined || label === "") return [{ type: "link", url, ...styled }];
  // A label is styled like text: each of its runs is a link of its own.
  return inline(label, style).map((element) =>
    element.type === "text"
      ? { type: "link", url, text: element.text, ...(element.style ? { style: element.style } : {}) }
      : element,
  );
}

/** Text with `<…>` entities and nothing else: what code and preformatted sections hold. */
function entitiesOnly(text: string, style: Style): Element[] {
  const out = new Elements(style);
  let from = 0;
  for (const match of text.matchAll(/<([^<>]+)>/g)) {
    out.text(text.slice(from, match.index));
    out.push(...entity(match[1] as string, style));
    from = match.index + match[0].length;
  }
  out.text(text.slice(from));
  return out.done();
}

// Sticky: each is tried at one position (`lastIndex`), without copying the rest of the text.
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>]+/y;
const BARE_EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/uy;
const TRAILING_PUNCTUATION = /[.,!?;:)\]'"]+$/;
const EMOJI = /:([A-Za-z0-9_+'-]+):(?::skin-tone-([2-6]):)?/y;

/** `pattern`'s match starting exactly at `at`, if any. */
const matchAt = (pattern: RegExp, text: string, at: number) => {
  pattern.lastIndex = at;
  return pattern.exec(text);
};

/** One line's worth of mrkdwn (or several, for a quote) → its elements, in `style`. */
function inline(text: string, style: Style): Element[] {
  const out = new Elements(style);
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    const before = text[i - 1];
    if (char === "<") {
      const end = text.indexOf(">", i);
      if (end > i + 1) {
        out.push(...entity(text.slice(i + 1, end), style));
        i = end + 1;
        continue;
      }
    }
    const marker = MARKERS[char];
    if (marker && !style.has(marker)) {
      const after = text[i + 1];
      const opens =
        !isWordChar(before) && before !== char && after !== undefined && !/\s/.test(after) && after !== char;
      if (opens) {
        let close = -1;
        for (let j = i + 2; j < text.length && text[j] !== "\n"; j++) {
          if (text[j] === char && !isWordChar(text[j + 1])) {
            close = j;
            break;
          }
        }
        if (close !== -1) {
          const inner = text.slice(i + 1, close);
          const styled = new Set(style).add(marker);
          out.push(...(marker === "code" ? entitiesOnly(inner, styled) : inline(inner, styled)));
          i = close + 1;
          continue;
        }
      }
    }
    if (char === ":") {
      const match = matchAt(EMOJI, text, i);
      const name = match?.[1];
      if (match && name && !/^\d+$/.test(name)) {
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
      const url = matchAt(BARE_URL, text, i)?.[0].replace(TRAILING_PUNCTUATION, "");
      if (url && url !== "www.") {
        out.push(
          url.startsWith("www.")
            ? { type: "link", url: `http://${unescapeText(url)}`, text: unescapeText(url), ...styleObject(style) }
            : { type: "link", url: unescapeText(url), ...styleObject(style) },
        );
        i += url.length;
        continue;
      }
    }
    if (!isWordChar(before) && before !== "." && isWordChar(char)) {
      const email = matchAt(BARE_EMAIL, text, i)?.[0];
      if (email) {
        out.push({ type: "link", url: `mailto:${email}`, text: email, ...styleObject(style) });
        i += email.length;
        continue;
      }
    }
    out.text(char);
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

/** Text between fences → its sections, and its quotes (runs of lines starting with `>`). */
function sectionsAndQuotes(text: string): Element[] {
  const elements: Element[] = [];
  const lines = text.split("\n");
  const isQuote = (line: string) => line.startsWith(">") || line.startsWith("&gt;");
  let k = 0;
  while (k < lines.length) {
    const group: string[] = [];
    const quoted = isQuote(lines[k] as string);
    while (k < lines.length && isQuote(lines[k] as string) === quoted) group.push(lines[k++] as string);
    if (!quoted) {
      const body = group.join("\n");
      if (body !== "") elements.push({ type: "rich_text_section", elements: inline(body, NO_STYLE) });
      continue;
    }
    const first = group[0] as string;
    const marker = first.startsWith("&gt;") ? "&gt;" : ">";
    const padded = first.slice(marker.length).startsWith(" ");
    // Slack strips `> ` from the quote's first line, and only `>` from the lines after it.
    const body = [
      first.slice(marker.length + (padded ? 1 : 0)),
      ...group.slice(1).map((line) => line.slice(line.startsWith("&gt;") ? 4 : 1)),
    ].join("\n");
    elements.push({ type: "rich_text_quote", elements: inline(body, NO_STYLE), contains_padding: padded });
  }
  return elements;
}

/** A single newline next to a fence goes; a blank line stays. */
const trimEdge = (text: string, start: boolean, end: boolean) => {
  let out = text;
  if (start && out.startsWith("\n") && !out.startsWith("\n\n")) out = out.slice(1);
  if (end && out.endsWith("\n") && !out.endsWith("\n\n")) out = out.slice(0, -1);
  return out;
};

/** The elements of the `rich_text` block Slack makes of `text`. */
export function richTextElements(text: string): Element[] {
  const elements: Element[] = [];
  const fences: Array<{ start: number; end: number; content: string }> = [];
  let search = 0;
  while (true) {
    const open = text.indexOf("```", search);
    if (open === -1) break;
    const close = text.indexOf("```", open + 3);
    if (close === -1) break;
    const content = text.slice(open + 3, close).replace(/^\n/, "");
    if (content === "") {
      search = close + 3;
      continue;
    }
    fences.push({ start: open, end: close + 3, content });
    search = close + 3;
  }
  let from = 0;
  for (const [n, fence] of fences.entries()) {
    elements.push(...sectionsAndQuotes(trimEdge(text.slice(from, fence.start), n > 0, true)));
    elements.push({ type: "rich_text_preformatted", elements: entitiesOnly(fence.content, NO_STYLE) });
    from = fence.end;
  }
  elements.push(...sectionsAndQuotes(trimEdge(text.slice(from), fences.length > 0, false)));
  return elements;
}
