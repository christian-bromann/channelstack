import type { Mailbox } from "../../core/email/index.ts";
import type { Awaitable } from "../../core/router/index.ts";
import type { TranscriptPrincipal } from "../../core/router/inspect.ts";
import type { GoogleStore } from "./fake/store.ts";
import type { FakeGoogleWorld } from "./fake/world.ts";
import type { GoogleEmailRecord, GoogleUserRecord } from "./world.ts";

/** What a person writes in an email. */
export interface GoogleMessageInput {
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
}

/**
 * What people do on Gmail that works live, written once. The fake implements it over its world
 * (`fakeGoogleWorld`); live mode over the Gmail API with each person's own account. Routes use `live ?? fake`.
 */
export interface GoogleWorld {
  /** The mail as the routes read it: the fake's own, or live, what was read back from Gmail. */
  readonly store: GoogleStore;
  createUser(
    session: string,
    input: { name: string; address?: string | undefined; token?: string | undefined },
  ): Awaitable<GoogleUserRecord>;
  send(session: string, person: GoogleUserRecord, input: GoogleMessageInput): Awaitable<GoogleEmailRecord>;
  reply(
    session: string,
    person: GoogleUserRecord,
    to: GoogleEmailRecord,
    input: { text: string | undefined; html: string | undefined; all: boolean },
  ): Awaitable<GoogleEmailRecord>;
  inbox(session: string, person: GoogleUserRecord): Awaitable<GoogleEmailRecord[]>;
  /** Read again what the agent may have changed: nothing to do in the fake, which holds the truth. */
  refresh(session: string): Awaitable<void>;
  /** The labels of an email's copy in the agent's mailbox: the fake's; live, none it can read. */
  labelsOf(email: GoogleEmailRecord): readonly string[];
  principalOf(email: GoogleEmailRecord): TranscriptPrincipal;
}

/** The fake as a `GoogleWorld`. */
export function fakeGoogleWorld(fake: FakeGoogleWorld): GoogleWorld {
  return {
    store: fake.store,
    createUser: (session, input) => fake.createUser(session, input),
    send: (session, person, input) => fake.personSends(session, person, input),
    reply: (session, person, to, input) => fake.personReplies(session, person, to, input),
    inbox: (_session, person) => fake.inbox(person),
    refresh: () => {},
    labelsOf: (email) =>
      email.agentCopy === undefined ? [] : [...(fake.store.messages.find(email.agentCopy)?.labels ?? [])],
    principalOf: fake.principalOf,
  };
}
