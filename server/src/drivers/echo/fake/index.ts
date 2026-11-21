import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { createEchoApi } from "./api.ts";
import { EchoStore } from "./store.ts";
import { createFakeWorld, type FakeEchoWorld } from "./world.ts";

/** The app's display name. Later drivers take theirs from `channelstack.config.ts`. */
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
        id: context.ids.next("echo.app"),
        name: APP_NAME,
        kind: "app",
        botUserId: context.ids.next("echo.user"),
      };
    },
    release(session: string) {
      store.releaseRooms(session);
    },
  } satisfies EchoFake;
  fake.seed();
  return fake;
}
