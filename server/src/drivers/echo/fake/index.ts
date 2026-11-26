import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { ECHO_IDS } from "../ids.ts";
import { createEchoApi } from "./api.ts";
import { EchoStore } from "./store.ts";
import { createFakeWorld, type FakeEchoWorld } from "./world.ts";

/** The app's display name. The other drivers' built-in app is `my-agent`. */
const APP_NAME = "echo-agent";

export interface EchoFake extends FakeBackend {
  readonly world: FakeEchoWorld;
}

/** The echo fake: a provider API over an in-memory store, wired to core's ids, event log and delivery queue. */
export function createEchoFake(context: DriverContext): EchoFake {
  const store = new EchoStore(context.registry);
  const world = createFakeWorld(context, store);
  const fake = {
    api: createEchoApi(context, store, world),
    world,
    seed() {
      store.clear();
      store.app = {
        id: context.ids.next(ECHO_IDS.app),
        name: APP_NAME,
        kind: "app",
      };
    },
    release(session: string) {
      store.releaseRooms(session);
    },
  } satisfies EchoFake;
  fake.seed();
  return fake;
}
