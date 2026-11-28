import { AppRoster, BUILT_IN_APP } from "../../../core/apps/index.ts";
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
    this.apps = new AppRoster("echo", registry);
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

  /** How core knows an app: echo's built-in app is `echo-agent`, but its secrets and endpoint are the built-in app's. */
  keyOf(app: EchoApp): string {
    return app.id === this.app.id ? BUILT_IN_APP : app.name;
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
