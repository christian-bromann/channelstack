import type { Mailbox } from "../../core/email/index.ts";
import type { Awaitable } from "../../core/router/index.ts";
import type { TranscriptPrincipal } from "../../core/router/inspect.ts";
import type { ResendStore } from "./fake/store.ts";
import type { FakeResendWorld } from "./fake/world.ts";
import type { ResendEmailRecord, ResendUserRecord } from "./world.ts";

/** What a person writes in an email. */
export interface ResendMessageInput {
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
}

/**
 * What people do on Resend that works live, written once. The fake implements it over its world
 * (`fakeResendWorld`); live mode over Resend's API with each person's own team. Routes use `live ?? fake`.
 */
export interface ResendWorld {
  /** The mail as the routes read it: the fake's own, or live, what was read back from Resend. */
  readonly store: ResendStore;
  createUser(
    session: string,
    input: { name: string; address?: string | undefined; token?: string | undefined },
  ): Awaitable<ResendUserRecord>;
  send(session: string, person: ResendUserRecord, input: ResendMessageInput): Awaitable<ResendEmailRecord>;
  reply(
    session: string,
    person: ResendUserRecord,
    to: ResendEmailRecord,
    input: { text: string | undefined; html: string | undefined; all: boolean },
  ): Awaitable<ResendEmailRecord>;
  inbox(session: string, person: ResendUserRecord): Awaitable<ResendEmailRecord[]>;
  /** Read again what the agent may have changed: nothing to do in the fake, which holds the truth. */
  refresh(session: string): Awaitable<void>;
  principalOf(email: ResendEmailRecord): TranscriptPrincipal;
}

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
