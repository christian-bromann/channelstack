import type { EmailWorld } from "../../core/email/routes.ts";
import type { FakeResendWorld } from "./fake/world.ts";
import type { ResendEmailRecord } from "./world.ts";

/**
 * What people do on Resend that works live: the email core's world. The fake implements it over
 * its world (`fakeResendWorld`); live mode over Resend's API with each person's own team. Routes use `live ?? fake`.
 */
export type ResendWorld = EmailWorld<ResendEmailRecord>;

/** The fake as a `ResendWorld`. */
export function fakeResendWorld(fake: FakeResendWorld): ResendWorld {
  return {
    store: fake.store,
    createUser: (session, input) => fake.createUser(session, input),
    send: (session, person, input) => fake.personSends(session, person, input),
    reply: (session, person, to, input) => fake.personReplies(session, person, to, input),
    inbox: (_session, person) => fake.inbox(person),
    refresh: () => {},
    principalOf: fake.principalOf,
  };
}
