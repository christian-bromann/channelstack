import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { RESEND_IDS } from "../ids.ts";
import { EMAIL_EVENTS } from "../payloads.ts";
import { createResendApi } from "./api.ts";
import { ResendStore } from "./store.ts";
import { createFakeWorld, type FakeResendWorld } from "./world.ts";

/** The agent's team, built in (there is no config file): one verified domain that sends and receives. */
const DEFAULT_TEAM = { name: "my-agent", domain: "acme.example" } as const;

export interface ResendFake extends FakeBackend {
  readonly world: FakeResendWorld;
  readonly store: ResendStore;
}

/** The Resend fake: the REST API over an in-memory team and the people's mailboxes, wired to core. */
export function createResendFake(context: DriverContext): ResendFake {
  const store = new ResendStore(context.registry);
  const world = createFakeWorld(context, store);
  // Who the team is is drawn once: the agent holds its address from `channelstack env`, and a reset keeps it.
  const identity = {
    app: context.ids.next(RESEND_IDS.domain),
    domain: context.ids.next(RESEND_IDS.domain),
    webhook: context.ids.next(RESEND_IDS.webhook),
  };
  const fake = {
    api: createResendApi(context, world),
    world,
    store,
    seed() {
      store.seed({
        id: identity.app,
        name: DEFAULT_TEAM.name,
        address: `${DEFAULT_TEAM.name}@${DEFAULT_TEAM.domain}`,
        domain: DEFAULT_TEAM.domain,
        domainId: identity.domain,
        webhookId: identity.webhook,
        events: EMAIL_EVENTS,
      });
    },
    release() {},
  } satisfies ResendFake;
  fake.seed();
  return fake;
}
