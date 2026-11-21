import type { Clock } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import type { IdGenerator } from "../ids/index.ts";

/** A scope inside the one shared world: it owns what it creates and sees only its own events. */
export interface Session {
  readonly id: string;
  readonly openedAt: number;
}

export class Sessions {
  readonly #ids: IdGenerator;
  readonly #clock: Clock;
  readonly #open = new Map<string, Session>();
  readonly #closeListeners: Array<(session: Session) => void> = [];

  constructor(ids: IdGenerator, clock: Clock) {
    this.#ids = ids;
    this.#clock = clock;
  }

  open(): Session {
    const session: Session = { id: this.#ids.next("channelstack.session"), openedAt: this.#clock() };
    this.#open.set(session.id, session);
    return session;
  }

  get(id: string): Session {
    const session = this.#open.get(id);
    if (!session) throw new ProtocolError("session_not_found", `No open session "${id}"`, { session: id });
    return session;
  }

  /** Close a session. Everything registered with `onClose` removes what the session owned. */
  close(id: string): void {
    const session = this.get(id);
    this.#open.delete(id);
    for (const listener of this.#closeListeners) listener(session);
  }

  /** Close every session (`POST /reset`). */
  closeAll(): void {
    for (const id of [...this.#open.keys()]) this.close(id);
  }

  onClose(listener: (session: Session) => void): void {
    this.#closeListeners.push(listener);
  }
}
