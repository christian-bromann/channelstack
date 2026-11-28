import { AppRoster } from "../../../core/apps/index.ts";
import { CursorList } from "../../../core/events/index.ts";
import type { Collection, Registry } from "../../../core/registry/index.ts";
import type { EchoApp, EchoMessage, EchoRoom, EchoUser } from "../world.ts";

/** The echo fake's in-memory state. Objects live in the core registry; the store adds the platform's own indexes. */
export class EchoStore {
  readonly users: Collection<EchoUser>;
  readonly rooms: Collection<EchoRoom>;
  readonly #messages = new Map<string, CursorList<EchoMessage>>();
  /** The built-in app and the ones tests made (decision 0027). */
  readonly apps: AppRoster<EchoApp>;

  constructor(registry: Registry) {
    this.apps = new AppRoster<EchoApp>("echo", registry, { refs: (app) => [app.id] });
    this.users = registry.collection<EchoUser>("echo", "user");
    this.rooms = registry.collection<EchoRoom>("echo", "room");
  }

  /** The built-in app. */
  get app(): EchoApp {
    return this.apps.builtIn;
  }

  set app(app: EchoApp) {
    this.apps.seed(app);
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
