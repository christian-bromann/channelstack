/**
 * Which test session a request belongs to when the request names none: a model call carries the
 * agent's prompt, not a session. The evidence, strongest first (decision 0029):
 *
 * 1. an id the fake minted for an earlier answer (a tool call's id, a response id);
 * 2. a tag the agent chose to send (`user`, metadata, a header): a session id, or a string only one session knows;
 * 3. and 4. strings only one session's deliveries and API answers hold, found in the prompt:
 *    ids and names (`owned_id`), and what its people wrote (`text`);
 * 5. when several sessions hold the same text and nothing else tells them apart: the one whose
 *    matching delivery is the oldest still unanswered (`order`).
 */

/** How a request was attributed. */
type AttributedBy = "minted_id" | "tag" | "owned_id" | "text" | "order";

/** One thing a session knows: a string the agent was sent, and where it came from. */
export interface KnownString {
  readonly text: string;
  /** The channel it came from (`slack`). */
  readonly driver: string;
  /** The delivery it was in, if it came from one. */
  readonly delivery?: string;
  /** When the agent got it. */
  readonly at: number;
}

/** Where attribution reads what each session knows. */
export interface AttributionSources {
  /** The open sessions. */
  sessions(): readonly string[];
  /** Everything a session's deliveries carried and its API calls answered, as strings. */
  known(session: string): readonly KnownString[];
}

export interface Attribution {
  readonly session: string;
  readonly by: AttributedBy;
  /** The string that decided it, when one did. */
  readonly matched?: string;
  /** Where that string came from. */
  readonly source?: KnownString;
  /** With `order`: the other sessions that sent the same text. */
  readonly tiedWith?: readonly string[];
}

/** What a request offers as evidence. */
export interface AttributionRequest {
  /** Ids in the request that an earlier answer of the fake minted (`call_…`, `resp_…`). */
  readonly minted: readonly string[];
  /** Values the agent tagged the request with. */
  readonly tags: readonly string[];
  /** Everything the request says: instructions, messages, tool results. */
  readonly text: string;
}

/** The shortest string that counts as evidence: "hi" or "thanks" decides nothing. */
const MIN_EVIDENCE = 8;
/** The longest string that is compared: past this, a string is a document, not something a person said. */
const MAX_EVIDENCE = 4000;

/**
 * Text as both sides are compared: mentions and links removed (the agent strips `<@U…>` or
 * resolves it), whitespace collapsed, case ignored.
 */
export function normalise(text: string): string {
  return text
    .replace(/<[@#!][^>]*>/g, " ")
    .replace(/<(https?:[^>|]+)(\|[^>]*)?>/g, " $1 ")
    .replace(/(^|\s)@[\w.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Every string inside a JSON value, and inside JSON or form text found in it (a Slack interaction's `payload`). */
export function stringsOf(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 32) return into;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
      try {
        return stringsOf(JSON.parse(trimmed), into, depth + 1);
      } catch {
        // Not JSON after all: it's text.
      }
    }
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, into, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) stringsOf(item, into, depth + 1);
  }
  return into;
}

/** A delivery's body as strings: JSON, or a form's fields. */
export function bodyStrings(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return stringsOf(JSON.parse(trimmed));
    } catch {
      return [body];
    }
  }
  if (/^[\w.%-]+=/.test(trimmed)) return stringsOf(Object.fromEntries(new URLSearchParams(trimmed)));
  return [body];
}

/** Text with spaces is something a person wrote; a single word is an id or a name. */
const isText = (text: string) => text.includes(" ");

export class Attributor {
  readonly #sources: AttributionSources;
  /** Ids minted for an answer, by the session it was for. */
  readonly #minted = new Map<string, string>();
  /** Per session: the deliveries an attributed call already answered. */
  readonly #answered = new Map<string, Set<string>>();

  constructor(sources: AttributionSources) {
    this.#sources = sources;
  }

  /** An answer for `session` carried these ids: a later request that names one is that session's. */
  mint(session: string, ids: Iterable<string>): void {
    for (const id of ids) this.#minted.set(id, session);
  }

  /** A closed session's ids and answers are forgotten. */
  forget(session: string): void {
    for (const [id, owner] of this.#minted) if (owner === session) this.#minted.delete(id);
    this.#answered.delete(session);
  }

  attribute(request: AttributionRequest): Attribution | undefined {
    const open = new Set(this.#sources.sessions());
    for (const id of request.minted) {
      const session = this.#minted.get(id);
      if (session !== undefined && open.has(session)) return this.#answer({ session, by: "minted_id", matched: id });
    }

    // What each session knows, normalised, and which strings more than one session knows.
    const knownBy = new Map<string, Map<string, KnownString>>();
    const owners = new Map<string, Set<string>>();
    for (const session of open) {
      const strings = new Map<string, KnownString>();
      for (const known of this.#sources.known(session)) {
        if (known.text.length > MAX_EVIDENCE) continue;
        const text = normalise(known.text);
        if (text.length < MIN_EVIDENCE) continue;
        const kept = strings.get(text);
        // The newest occurrence: what the agent was told last.
        if (!kept || kept.at < known.at) strings.set(text, known);
        let holders = owners.get(text);
        if (!holders) {
          holders = new Set();
          owners.set(text, holders);
        }
        holders.add(session);
      }
      knownBy.set(session, strings);
    }

    for (const tag of request.tags) {
      if (open.has(tag)) return this.#answer({ session: tag, by: "tag", matched: tag });
      const holders = owners.get(normalise(tag));
      if (holders?.size === 1) {
        const [session] = holders as Set<string>;
        // Where the tag came from (the delivery that carried a person's id) says where the call belongs.
        const source = knownBy.get(session as string)?.get(normalise(tag));
        return this.#answer({ session: session as string, by: "tag", matched: tag, ...(source ? { source } : {}) });
      }
    }

    const prompt = normalise(request.text);
    if (prompt === "") return undefined;
    let best: { session: string; score: number; matched: string; source: KnownString } | undefined;
    const tied = new Map<string, { source: KnownString; matched: string }>();
    for (const [session, strings] of knownBy) {
      let score = 0;
      let longest: { text: string; source: KnownString } | undefined;
      for (const [text, source] of strings) {
        if (!prompt.includes(text)) continue;
        if ((owners.get(text)?.size ?? 0) > 1) {
          // The same text in several sessions: it can't decide, but it can tie.
          if (isText(text)) {
            const kept = tied.get(session);
            if (!kept || kept.matched.length < text.length) tied.set(session, { source, matched: text });
          }
          continue;
        }
        score += text.length;
        if (!longest || longest.text.length < text.length) longest = { text, source };
      }
      if (longest && (!best || best.score < score))
        best = { session, score, matched: longest.text, source: longest.source };
    }
    if (best) {
      const by = isText(best.matched) ? "text" : "owned_id";
      return this.#answer({ session: best.session, by, matched: best.matched, source: best.source });
    }
    if (tied.size === 0) return undefined;

    // Only text several sessions share: the oldest delivery not yet answered gets it.
    const candidates = [...tied].sort(([, a], [, b]) => a.source.at - b.source.at);
    const unanswered = candidates.find(
      ([session, { source }]) => source.delivery === undefined || !this.#answered.get(session)?.has(source.delivery),
    );
    const [session, { source, matched }] = unanswered ?? (candidates[0] as (typeof candidates)[number]);
    return this.#answer({
      session,
      by: "order",
      matched,
      source,
      tiedWith: candidates.map(([other]) => other).filter((other) => other !== session),
    });
  }

  #answer(attribution: Attribution): Attribution {
    const delivery = attribution.source?.delivery;
    if (delivery !== undefined) {
      let answered = this.#answered.get(attribution.session);
      if (!answered) {
        answered = new Set();
        this.#answered.set(attribution.session, answered);
      }
      answered.add(delivery);
    }
    return attribution;
  }
}
