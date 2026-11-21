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
  readonly botUserId: string;
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
  createRoom(session: string, input: { name?: string | undefined; participants: readonly string[] }): EchoRoom;
  postAsUser(session: string, user: string, room: string, text: string): EchoMessage;
  messages(session: string, room: string, since?: string): { messages: EchoMessage[]; cursor: string };
}
