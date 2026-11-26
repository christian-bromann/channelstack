import type { EmailWorld } from "../../core/email/routes.ts";
import type { FakeGoogleWorld } from "./fake/world.ts";
import type { GoogleEmailRecord } from "./world.ts";

/**
 * What people do on Gmail that works live: the email core's world, and the labels of an email's
 * copy in the agent's mailbox. The fake implements it over its world (`fakeGoogleWorld`); live mode
 * over the Gmail API with each person's own account. Routes use `live ?? fake`.
 */
export interface GoogleWorld extends EmailWorld<GoogleEmailRecord> {
  /** The labels of an email's copy in the agent's mailbox, fake and live (without the run's own). */
  labelsOf(email: GoogleEmailRecord): readonly string[];
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
