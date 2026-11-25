const REDACTED = "[redacted]";

const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

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

  /** For logs and error messages: tokens, registered secrets, anything after `Bearer`, and emails. */
  text(input: string): string {
    return this.#tokensIn(input).replace(BEARER_PATTERN, `$1 ${REDACTED}`).replace(EMAIL_PATTERN, REDACTED);
  }

  /**
   * For recorded payloads: tokens by their shape and registered secrets, in every string of a JSON
   * value. Everything else is kept as it was said, because the event log is what tests read.
   */
  tokens<T>(value: T): T {
    if (typeof value === "string") return this.#tokensIn(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.tokens(item)) as T;
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.tokens(item)])) as T;
    }
    return value;
  }

  #tokensIn(input: string): string {
    let out = input;
    for (const literal of this.#literals) out = out.split(literal).join(REDACTED);
    for (const pattern of this.#patterns) out = out.replace(pattern, REDACTED);
    return out;
  }
}
