const REDACTED = "[redacted]";

/** What follows `Bearer`, or `Basic` (a key and its secret, in base64: Twilio's API). */
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** An address, as written or as a URL carries it (`ana%40example.com`). */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;

/**
 * Scrubs tokens, signing secrets and emails. Everything that leaves the server as a log line or
 * an error message goes through `text`; everything recorded in the event log goes through `tokens`.
 */
export class Redactor {
  readonly #literals = new Set<string>();
  readonly #patterns: readonly RegExp[];

  /** `patterns`: the shapes of every platform's tokens, which each driver declares (`tokenPatterns`). */
  constructor(patterns: readonly RegExp[] = []) {
    this.#patterns = patterns;
  }

  /** Register a secret value that has no recognisable shape (signing secrets, the bearer token). */
  register(...secrets: string[]): void {
    for (const secret of secrets) if (secret.length >= 8) this.#literals.add(secret);
  }

  /** For logs and error messages: tokens, registered secrets, anything after `Bearer` or `Basic`, and emails. */
  text(input: string): string {
    return this.#tokensIn(input).replace(BEARER_PATTERN, `$1 ${REDACTED}`).replace(EMAIL_PATTERN, REDACTED);
  }

  /**
   * For recorded payloads: tokens by their shape and registered secrets, in every string of a JSON
   * value. Everything else is kept as it was said, because the event log is what tests read.
   */
  tokens<T>(value: T): T {
    return eachString(value, (text) => this.#tokensIn(text));
  }

  /** For error data, which can quote ids and addresses: `text` on every string of a JSON value. */
  data<T>(value: T): T {
    return eachString(value, (text) => this.text(text));
  }

  #tokensIn(input: string): string {
    let out = input;
    for (const literal of this.#literals) out = out.split(literal).join(REDACTED);
    for (const pattern of this.#patterns) out = out.replace(pattern, REDACTED);
    return out;
  }
}

/** `value` with `scrub` applied to each string in it. */
function eachString<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((item) => eachString(item, scrub)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, eachString(item, scrub)])) as T;
  }
  return value;
}
