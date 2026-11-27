import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { TWILIO_IDS } from "../ids.ts";
import { createTwilioApi } from "./api.ts";
import { TwilioStore } from "./store.ts";
import { createFakeWorld, type FakeTwilioWorld } from "./world.ts";

export interface TwilioFake extends FakeBackend {
  readonly world: FakeTwilioWorld;
  readonly store: TwilioStore;
  /** The account's API key and its test credentials' Account SID: drawn once, as the agent holds them from `channelstack env`. */
  readonly keys: { readonly apiKeySid: string; readonly testAccountSid: string };
}

/** The Twilio fake: the REST API over an in-memory account with one number, wired to core. */
export function createTwilioFake(context: DriverContext): TwilioFake {
  const store = new TwilioStore(context.registry);
  const world = createFakeWorld(context, store);
  // Who the account is is drawn once: the agent holds its SID and number from `channelstack env`, and a reset keeps them.
  const identity = {
    account: context.ids.next(TWILIO_IDS.account),
    number: context.ids.next(TWILIO_IDS.number),
    numberSid: context.ids.next(TWILIO_IDS.phoneNumber),
    service: context.ids.next(TWILIO_IDS.messagingService),
  };
  const keys = { apiKeySid: context.ids.next(TWILIO_IDS.apiKey), testAccountSid: context.ids.next(TWILIO_IDS.account) };
  const fake = {
    api: createTwilioApi(context, world, keys),
    world,
    store,
    keys,
    seed() {
      store.seed({
        id: identity.numberSid,
        name: "my-agent",
        number: identity.number,
        accountSid: identity.account,
        messagingServiceSid: identity.service,
      });
    },
    release: (session) => store.release(session),
  } satisfies TwilioFake;
  fake.seed();
  return fake;
}
