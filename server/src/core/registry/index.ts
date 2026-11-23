import { ProtocolError } from "../errors/index.ts";

interface Entry<T> {
  readonly owner: string | undefined;
  readonly value: T;
}

/** One type of object in one driver, with who owns each. */
export class Collection<T> {
  readonly #label: string;
  readonly #entries = new Map<string, Entry<T>>();

  constructor(label: string) {
    this.#label = label;
  }

  /** Record an object. `owner` is the session that created it; leave it out for world-level objects (the app). */
  add(id: string, value: T, owner?: string): T {
    this.#entries.set(id, { owner, value });
    return value;
  }

  /** Resolve a handle id for a session: its own objects and world-level ones. Anything else doesn't exist for it. */
  get(session: string, id: string): T {
    const entry = this.#entries.get(id);
    if (!entry || (entry.owner !== undefined && entry.owner !== session)) {
      throw new ProtocolError("not_found", `No ${this.#label} "${id}" in this session`, { id });
    }
    return entry.value;
  }

  /** Look an object up from the platform's side, where there are no sessions (the agent's API calls). */
  find(id: string): T | undefined {
    return this.#entries.get(id)?.value;
  }

  /** A session's objects, oldest first. */
  list(session: string): T[] {
    return [...this.#entries.values()].filter((entry) => entry.owner === session).map((entry) => entry.value);
  }

  /** Every object, oldest first: the workspace as the platform's side sees it. */
  values(): T[] {
    return [...this.#entries.values()].map((entry) => entry.value);
  }

  /** The session an object belongs to, for attributing events. */
  owner(id: string): string | undefined {
    return this.#entries.get(id)?.owner;
  }

  /** Take one object out: it was deleted on the platform, so no handle resolves to it any more. */
  remove(id: string): void {
    this.#entries.delete(id);
  }

  release(session: string): T[] {
    const released: T[] = [];
    for (const [id, entry] of this.#entries) {
      if (entry.owner !== session) continue;
      this.#entries.delete(id);
      released.push(entry.value);
    }
    return released;
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Every object the fakes hold, by driver and type. Drivers get their collections here instead of keeping private maps. */
export class Registry {
  readonly #collections = new Map<string, Collection<unknown>>();

  collection<T>(driver: string, type: string): Collection<T> {
    const key = `${driver}.${type}`;
    let collection = this.#collections.get(key);
    if (!collection) {
      collection = new Collection<unknown>(`${driver} ${type}`);
      this.#collections.set(key, collection);
    }
    return collection as Collection<T>;
  }

  /** Remove everything a closed session owned. */
  release(session: string): void {
    for (const collection of this.#collections.values()) collection.release(session);
  }

  clear(): void {
    for (const collection of this.#collections.values()) collection.clear();
  }
}
