import type { Clock } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import type { IdGenerator } from "../ids/index.ts";
import { CHANNELSTACK_IDS } from "../ids/index.ts";

/** A scope inside the one shared world: it owns what it creates and sees only its own events. */
export interface Session {
  readonly id: string;
  readonly openedAt: number;
  /** A session opened by name is shared: whoever asks for the name gets the same one. */
  readonly name?: string;
}

export class Sessions {
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #open = new Map<string, Session>();
  readonly #closeListeners: Array<(session: Session) => void | Promise<void>> = [];

  constructor(ids: IdGenerator, clock: Clock) {
    this.#ids = ids;
    this.#clock = clock;
  }

  /**
   * Open a session. With a name, the open session of that name is returned if there is one: the
   * CLI, the UI and MCP share a long-lived session called `dev` this way.
   */
  open(name?: string): Session {
    const existing = name === undefined ? undefined : [...this.#open.values()].find((open) => open.name === name);
    if (existing) return existing;
    const session: Session = {
      id: this.#ids.next(CHANNELSTACK_IDS.session),
      openedAt: this.#clock(),
      ...(name === undefined ? {} : { name }),
    };
    this.#open.set(session.id, session);
    return session;
  }

  /** The open sessions' ids. */
  ids(): string[] {
    return [...this.#open.keys()];
  }

  get(id: string): Session {
    const session = this.#open.get(id);
    if (!session) throw new ProtocolError("session_not_found", `No open session "${id}"`, { session: id });
    return session;
  }

  /**
   * Close a session. Everything registered with `onClose` removes what the session owned, in
   * order; it resolves once the last of them did (live cleanup calls the real platform).
   */
  async close(id: string): Promise<void> {
    const session = this.get(id);
    this.#open.delete(id);
    for (const listener of this.#closeListeners) await listener(session);
  }

  /** Close every session (`POST /reset`, and the server stopping). */
  async closeAll(): Promise<void> {
    for (const id of [...this.#open.keys()]) await this.close(id);
  }

  onClose(listener: (session: Session) => void | Promise<void>): void {
    this.#closeListeners.push(listener);
  }
}
