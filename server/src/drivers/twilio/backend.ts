import type { Awaitable } from "../../core/router/index.ts";
import type { TranscriptPrincipal } from "../../core/router/inspect.ts";
import type { TwilioStore } from "./fake/store.ts";
import type { FakeTwilioWorld } from "./fake/world.ts";
import type { TwilioMessageRecord, TwilioPersonRecord } from "./world.ts";

/**
 * What people do on Twilio that works live. The fake implements it over its world
 * (`fakeTwilioWorld`); live mode over Twilio's API, each person with the account that owns their
 * number. Routes use `live ?? fake`.
 */
export interface TwilioWorld {
  /** The messages as the routes read them: the fake's own, or live, what was read back from Twilio. */
  readonly store: TwilioStore;
  createUser(
    session: string,
    input: { name: string; number?: string | undefined; reachable?: boolean | undefined; token?: string | undefined },
  ): Awaitable<TwilioPersonRecord>;
  text(
    session: string,
    person: TwilioPersonRecord,
    input: { to: string; body: string; media: readonly string[] },
  ): Awaitable<TwilioMessageRecord>;
  /** What reached the person's phone, oldest first. */
  inbox(session: string, person: TwilioPersonRecord): Awaitable<TwilioMessageRecord[]>;
  /** Read again what the agent may have sent: nothing to do in the fake, which holds the truth. */
  refresh(session: string): Awaitable<void>;
  principalOf(message: TwilioMessageRecord): TranscriptPrincipal;
}

/** The fake as a `TwilioWorld`. */
export function fakeTwilioWorld(fake: FakeTwilioWorld): TwilioWorld {
  return {
    store: fake.store,
    createUser: (session, input) => fake.createUser(session, input),
    text: (session, person, input) => fake.personTexts(session, person, input),
    inbox: (_session, person) => fake.messagesTo(person),
    refresh: () => {},
    principalOf: fake.principalOf,
  };
}
