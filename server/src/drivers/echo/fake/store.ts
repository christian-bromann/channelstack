import { CursorList } from "../../../core/events/index.ts";
import type { Collection, Registry } from "../../../core/registry/index.ts";
import type { EchoApp, EchoMessage, EchoRoom, EchoUser } from "../world.ts";

/** The echo fake's in-memory state. Objects live in the core registry; the store adds the platform's own indexes. */
export class EchoStore {
  readonly users: Collection<EchoUser>;
  readonly rooms: Collection<EchoRoom>;
  readonly #messages = new Map<string, CursorList<EchoMessage>>();
  #app: EchoApp | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection<EchoUser>("echo", "user");
    this.rooms = registry.collection<EchoRoom>("echo", "room");
  }

  get app(): EchoApp {
    if (!this.#app) throw new Error("The echo fake hasn't been seeded");
    return this.#app;
  }

  set app(app: EchoApp) {
    this.#app = app;
  }

  messagesIn(room: string): CursorList<EchoMessage> {
    let messages = this.#messages.get(room);
    if (!messages) {
      messages = new CursorList();
      this.#messages.set(room, messages);
    }
    return messages;
  }

  /** Drop the messages of rooms a closed session owned. */
  releaseRooms(session: string): void {
    for (const room of this.#messages.keys()) if (this.rooms.owner(room) === session) this.#messages.delete(room);
  }

  clear(): void {
    this.#messages.clear();
  }
}
