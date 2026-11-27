import { randomToken } from "../secrets/index.ts";
import { constantTimeEqual } from "../signing/hmac.ts";

/** The cookie a browser holds after it opened a login link. */
export const UI_COOKIE = "channelstack_ui";

/**
 * What a browser session may do: read what the UI shows, and nothing else. It never reaches
 * `/env` or a fixture (they return the agent's tokens), and it can't change anything, so a
 * page that tricks the browser into a request gains nothing.
 */
const UI_READS =
  /^\/(status|sessions\/[^/]+\/(events|quiet|places(\/[a-z]+\/[^/]+\/transcript)?|[a-z]+\/(users|conversations)(\/.*)?))$/;

/**
 * Browser access to the UI. The server prints a one-time login link; opening it trades the code
 * in the link for a session cookie. Codes and sessions live in memory and end with the server.
 */
export class UiAccess {
  readonly #codes = new Set<string>();
  readonly #sessions = new Set<string>();
  readonly #secret: (value: string) => void;

  /** `secret` is told every code and session token, so they are scrubbed from logs like any other secret. */
  constructor(secret: (value: string) => void) {
    this.#secret = secret;
  }

  /** A new one-time login code, from the CSPRNG. */
  issueCode(): string {
    const code = randomToken(32);
    this.#secret(code);
    this.#codes.add(code);
    return code;
  }

  /** Trade a login code for a session token. A code works once; an unknown or used one gives nothing. */
  redeem(code: string): string | undefined {
    const known = [...this.#codes].find((candidate) => constantTimeEqual(candidate, code));
    if (known === undefined) return undefined;
    this.#codes.delete(known);
    const session = randomToken(32);
    this.#secret(session);
    this.#sessions.add(session);
    return session;
  }

  /** Is this the token of a browser session? */
  knows(session: string | undefined): boolean {
    return session !== undefined && [...this.#sessions].some((candidate) => constantTimeEqual(candidate, session));
  }

  /** May a browser session make this control API request? Only the reads the UI shows. */
  allows(session: string | undefined, method: string, path: string): boolean {
    return method === "GET" && UI_READS.test(path) && this.knows(session);
  }
}
