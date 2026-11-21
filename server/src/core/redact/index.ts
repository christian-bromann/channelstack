const REDACTED = "[redacted]";

/** Shapes of the tokens the four platforms (and the echo driver) issue, fake or real. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /xox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /xapp-\d-[A-Za-z0-9-]{10,}/g,
  /gh[opsur]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /lin_(?:api|oauth|wh)_[A-Za-z0-9]{16,}/g,
  /ntn_[A-Za-z0-9]{20,}/g,
  /secret_[A-Za-z0-9]{20,}/g,
  /echo_app_[A-Za-z0-9]{20,}/g,
];
const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Scrubs tokens, signing secrets and emails. Everything that leaves the server as a log line or
 * an error message goes through `text`; everything recorded in the event log goes through `tokens`.
 */
export class Redactor {
  readonly #literals = new Set<string>();

  /** Register a secret value that has no recognisable shape (signing secrets, the bearer token). */
  register(...secrets: string[]): void {
    for (const secret of secrets) if (secret.length >= 8) this.#literals.add(secret);
  }

  /** For logs and error messages: tokens, registered secrets and emails. */
  text(input: string): string {
    return this.#tokensIn(input).replace(EMAIL_PATTERN, REDACTED);
  }

  /** For recorded payloads: tokens and registered secrets, in every string of a JSON value. Content is kept. */
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
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
    return out.replace(BEARER_PATTERN, `$1 ${REDACTED}`);
  }
}
