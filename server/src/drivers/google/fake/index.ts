import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { GOOGLE_IDS } from "../ids.ts";
import { createGoogleApi } from "./api.ts";
import { type PushCertificates, pushCertificates } from "./certs.ts";
import { GoogleStore } from "./store.ts";
import { createFakeWorld, type FakeGoogleWorld } from "./world.ts";

/** The agent's mailbox, built in (there is no config file): a Workspace address on the fake's domain. */
const DEFAULT_MAILBOX = { name: "my-agent", address: "my-agent@acme.example" } as const;

export interface GoogleFake extends FakeBackend {
  readonly world: FakeGoogleWorld;
  readonly store: GoogleStore;
}

/** The Google fake: Gmail's API over an in-memory mailbox and the people's mail, wired to core. */
export function createGoogleFake(context: DriverContext): GoogleFake {
  const store = new GoogleStore(context.registry);
  const world = createFakeWorld(context, store);
  // Who the mailbox is, and where its history starts, are drawn once: a reset keeps them.
  const identity = { account: context.ids.next(GOOGLE_IDS.account), history: context.ids.next(GOOGLE_IDS.history) };
  let certificates: Promise<PushCertificates> | undefined;
  const certs = () => (certificates ??= pushCertificates(context.secret("pushKey"), world.keyId(), context.clock()));
  const fake = {
    api: createGoogleApi(context, world, certs),
    world,
    store,
    seed() {
      store.seed(
        { id: identity.account, name: DEFAULT_MAILBOX.name, address: DEFAULT_MAILBOX.address },
        identity.history,
      );
    },
    release: (session: string) => world.release(session),
  } satisfies GoogleFake;
  fake.seed();
  return fake;
}
