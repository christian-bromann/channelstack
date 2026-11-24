import type { LiveCredential } from "../secrets/index.ts";

/**
 * The real people of a live world's open sessions. A live person is an account of the sandbox's
 * shared pool, so parallel tests have the same one: each session that creates them holds them,
 * with their credential and the session's own name for them, and nobody takes them from another
 * session. A live world keeps their record outside any one session, and lets it go once the last
 * session that holds them closes.
 */
export class LivePeople {
  readonly #sessions = new Map<string, Map<string, { credential: LiveCredential; alias: string }>>();

  /** The session now holds this person, as `alias`, acting with `credential`. */
  join(session: string, id: string, alias: string, credential: LiveCredential): void {
    const held = this.#sessions.get(session) ?? new Map<string, { credential: LiveCredential; alias: string }>();
    held.set(id, { credential, alias });
    this.#sessions.set(session, held);
  }

  /** The person's credential, from any session that holds them: it is the same account. */
  credential(id: string): LiveCredential | undefined {
    for (const held of this.#sessions.values()) {
      const person = held.get(id);
      if (person) return person.credential;
    }
    return undefined;
  }

  /** Whether this session holds the person. */
  holds(session: string, id: string): boolean {
    return this.#sessions.get(session)?.has(id) === true;
  }

  /** The people this session holds, in the order it created them, with its names for them. */
  of(session: string): Array<{ id: string; alias: string; credential: LiveCredential }> {
    return [...(this.#sessions.get(session) ?? new Map()).entries()].map(([id, person]) => ({ id, ...person }));
  }

  /** The credential a ledger entry names (`user:ANA`), among this session's people. */
  byOwner(session: string, owner: string): LiveCredential | undefined {
    return this.of(session).find((person) => person.credential.owner === owner)?.credential;
  }

  /** The session closed: it holds nobody now. Answers who no open session holds any more. */
  leave(session: string): string[] {
    const held = [...(this.#sessions.get(session)?.keys() ?? [])];
    this.#sessions.delete(session);
    return held.filter((id) => ![...this.#sessions.values()].some((other) => other.has(id)));
  }
}
