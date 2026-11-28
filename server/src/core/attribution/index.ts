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
 *
 * A retry (the same request again, as the SDK says it is) goes where its first attempt went,
 * with the same evidence: never by order to another session. When several sessions' first
 * attempts were the same request, a retry goes to the oldest of them whose call failed.
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
  /** The request as sent (`key`, its body's hash), and whether the client says it is sending it again. */
  readonly attempt?: { readonly key: string; readonly retry: boolean };
}

/** The shortest string that counts as evidence: "hi" or "thanks" decides nothing. */
const MIN_EVIDENCE = 8;
/** The longest string that is compared: past this, a string is a document, not something a person said. */
const MAX_EVIDENCE = 4000;
/** How many requests' first attempts are remembered for their retries. */
const ATTEMPTS = 1000;

/** A first attempt that a retry may follow: where it went, and whether its call failed. */
interface FirstAttempt {
  readonly attribution: Attribution;
  failed: boolean;
}

/** A rule of `TEXT_NORMALISATION`: every match of `pattern` becomes `replacement`, where `$1` is the pattern's first group. */
interface NormalisationRule {
  readonly pattern: string;
  readonly replacement: string;
}

/**
 * Text as both sides are compared, as data: the rules in order, then whitespace collapsed and
 * trimmed, then lowercased. The spec publishes it (`x-channelstack-text-normalisation`) and every
 * SDK's matchers apply the table generated from it, so `toHaveSent` compares as attribution does.
 * The patterns are written so JavaScript, Python's `re` and Rust's `regex` read them alike: no
 * lookaround, no backreferences, no `\w` (whose meaning differs between them).
 */
export const TEXT_NORMALISATION: {
  readonly rules: readonly NormalisationRule[];
  readonly collapseWhitespace: boolean;
  readonly lowercase: boolean;
} = {
  rules: [
    // A mention as the platform writes it (`<@U…>`, `<#C…>`, `<!here>`): the agent strips it or resolves it.
    { pattern: "<[@#!][^>]*>", replacement: " " },
    // A Slack link is its URL.
    { pattern: "<(https?:[^>|]+)(\\|[^>]*)?>", replacement: " $1 " },
    // A mention as a person types it (`@my-agent`).
    { pattern: "(^|\\s)@[A-Za-z0-9_.-]+", replacement: " " },
  ],
  collapseWhitespace: true,
  lowercase: true,
};

const RULES = TEXT_NORMALISATION.rules.map(
  ({ pattern, replacement }) => [new RegExp(pattern, "g"), replacement] as const,
);

/** Text as both sides are compared (`TEXT_NORMALISATION`): mentions and links removed, whitespace collapsed, case ignored. */
export function normalise(text: string): string {
  let normalised = RULES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
  if (TEXT_NORMALISATION.collapseWhitespace) normalised = normalised.replace(/\s+/g, " ").trim();
  return TEXT_NORMALISATION.lowercase ? normalised.toLowerCase() : normalised;
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
  /**
   * Per request key: its first attempts, one per session, oldest first. When two sessions send the
   * same request, each keeps its own, so a retry never takes another session's place.
   */
  readonly #attempts = new Map<string, Map<string, FirstAttempt>>();

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
    for (const [key, firsts] of this.#attempts) {
      firsts.delete(session);
      if (firsts.size === 0) this.#attempts.delete(key);
    }
  }

  attribute(request: AttributionRequest): Attribution | undefined {
    const { attempt } = request;
    const first = attempt?.retry ? this.#retried(attempt.key) : undefined;
    if (first) return first;
    const found = this.#attribute(request);
    if (attempt && found) this.#remember(attempt.key, found);
    return found;
  }

  /**
   * How the call of a request (`key`) attributed to `session` ended: one that failed may be
   * retried; one that didn't is no longer waiting for a retry.
   */
  settled(key: string, session: string, failed: boolean): void {
    const firsts = this.#attempts.get(key);
    const first = firsts?.get(session);
    if (!firsts || !first) return;
    if (failed) {
      first.failed = true;
      return;
    }
    firsts.delete(session);
    if (firsts.size === 0) this.#attempts.delete(key);
  }

  /** The first attempt a retry follows: the oldest of an open session whose call failed, else the oldest. */
  #retried(key: string): Attribution | undefined {
    const open = new Set(this.#sources.sessions());
    const firsts = [...(this.#attempts.get(key)?.values() ?? [])].filter((first) =>
      open.has(first.attribution.session),
    );
    const first = firsts.find((candidate) => candidate.failed) ?? firsts[0];
    if (!first) return undefined;
    // In flight again, until it settles.
    first.failed = false;
    return first.attribution;
  }

  #remember(key: string, attribution: Attribution): void {
    const firsts = this.#attempts.get(key) ?? new Map<string, FirstAttempt>();
    // The newest request last, so the oldest is forgotten first; a session's newer attempt replaces its older one.
    this.#attempts.delete(key);
    firsts.delete(attribution.session);
    firsts.set(attribution.session, { attribution, failed: false });
    this.#attempts.set(key, firsts);
    if (this.#attempts.size > ATTEMPTS) this.#attempts.delete(this.#attempts.keys().next().value as string);
  }

  #attribute(request: AttributionRequest): Attribution | undefined {
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
