/** The echo platform's nouns. Echo is channelstack's own minimal platform: people, rooms and messages. */
export interface EchoPrincipal {
  readonly id: string;
  readonly name: string;
  readonly kind: "user" | "app";
}

export interface EchoUser extends EchoPrincipal {
  readonly kind: "user";
}

export interface EchoApp extends EchoPrincipal {
  readonly kind: "app";
}

export interface EchoRoom {
  readonly id: string;
  readonly name: string;
  readonly members: string[];
}

export interface EchoMessage {
  readonly id: string;
  readonly room: string;
  readonly author: EchoPrincipal;
  readonly text: string;
  readonly at: string;
  /** The delivery this message caused to the agent, if any. */
  readonly delivery?: string;
}

/**
 * Every control action, written once. The fake implements it over its store; a live
 * backend would implement the same interface against a real platform (architecture.md 3.3).
 */
export interface EchoWorld {
  app(): EchoApp;
  createUser(session: string, input: { name: string }): EchoUser;
  /** The apps a session used (decision 0027): the built-in one first, then each it got from `createApp`. */
  apps(session: string): EchoApp[];
  /** Make an app by name, or return the one of that name. */
  createApp(session: string | undefined, input: { name: string }): EchoApp;
  /** An app a test made writes in a room it is a member of. */
  sayAsApp(session: string, app: string, room: string, text: string): EchoMessage;
  createRoom(session: string, input: { name?: string | undefined; participants: readonly string[] }): EchoRoom;
  postAsUser(session: string, user: string, room: string, text: string): EchoMessage;
  messages(session: string, room: string, since?: string): { messages: EchoMessage[]; cursor: string };
}
