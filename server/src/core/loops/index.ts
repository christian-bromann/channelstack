import type { EventLog } from "../events/index.ts";

/**
 * The loop guard (decision 0027): apps that answer each other without end are stopped, in the
 * fake only, so a looping test fails at once instead of spinning until its timeout.
 *
 * Each driver says, from one helper every write goes through (a message, a comment, a review, an
 * edit, a reaction, a page change), who wrote in which conversation. The guard counts the apps'
 * writes in each conversation since a person last wrote there, and once they pass the limit it
 * stops the events those writes cause, records a `bot_loop` event, and names the loop to every
 * check and to the test's fixture. The real platforms have no such stop: they throttle.
 */

/** App messages in one conversation, with no person between them, that are still delivered: the next one stops it. */
export const LOOP_LIMIT = 50;

/** Who wrote a message: a person, or an app by its name. */
export type Writer = { readonly kind: "person" } | { readonly kind: "app"; readonly name: string };

interface Count {
  messages: number;
  /** The apps that wrote, in turn, for the message that names the loop. */
  readonly authors: string[];
  stopped: boolean;
}

/** One driver's view of the guard, with its name filled in: what `DriverContext.loops` is. */
export interface DriverLoops {
  /**
   * Someone wrote in `conversation`: a person starts the count over, an app adds to it. Answers
   * whether the events this message causes may be delivered: false once apps looped there. The
   * one call a driver's message path makes.
   */
  wrote(session: string, conversation: string, writer: Writer): boolean;
  /** May an event an app's message caused in `conversation` still be delivered? */
  allows(session: string, conversation: string): boolean;
}

export class LoopGuard {
  readonly #counts = new Map<string, Count>();
  readonly #stopped = new Map<string, string[]>();
  readonly #events: EventLog;
  readonly #limit: number;

  constructor(events: EventLog, limit = LOOP_LIMIT) {
    this.#events = events;
    this.#limit = limit;
  }

  /** The guard as one driver uses it. */
  for(driver: string): DriverLoops {
    return {
      wrote: (session, conversation, writer) => this.wrote(session, driver, conversation, writer),
      allows: (session, conversation) => this.allows(session, driver, conversation),
    };
  }

  wrote(session: string, driver: string, conversation: string, writer: Writer): boolean {
    const key = `${session}\u0000${driver}\u0000${conversation}`;
    if (writer.kind === "person") {
      this.#counts.delete(key);
      return true;
    }
    const count = this.#counts.get(key) ?? { messages: 0, authors: [], stopped: false };
    this.#counts.set(key, count);
    count.messages += 1;
    count.authors.push(writer.name);
    if (count.stopped) return false;
    if (count.messages <= this.#limit) return true;
    count.stopped = true;
    const turns = count.authors.slice(-6).join(" → ");
    // A noun phrase: the fixtures say "The fake stopped …", the matchers "Stopped: …".
    const text = `a bot loop in ${driver} ${conversation} (${this.#limit} app messages with no person between them: ${turns} …)`;
    this.#stopped.set(session, [...(this.#stopped.get(session) ?? []), text]);
    this.#events.append(session, driver, "bot_loop", {
      conversation,
      messages: this.#limit,
      authors: [...new Set(count.authors)],
    });
    return false;
  }

  allows(session: string, driver: string, conversation: string): boolean {
    return this.#counts.get(`${session}\u0000${driver}\u0000${conversation}`)?.stopped !== true;
  }

  /** The loops the guard stopped in a session, in words. */
  stopped(session: string): string[] {
    return this.#stopped.get(session) ?? [];
  }

  /** A closed session's counts go with it. */
  forget(session: string): void {
    this.#stopped.delete(session);
    for (const key of [...this.#counts.keys()]) if (key.startsWith(`${session}\u0000`)) this.#counts.delete(key);
  }
}
