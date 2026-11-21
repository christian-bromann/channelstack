import { afterEach, beforeEach, expect, inject } from "vitest";

import { type Channelstack, connect, type Session, untilQuiet } from "../../sdks/typescript/client.ts";
import { type MatcherName, matchers, type MatcherState } from "../matchers-core/index.ts";

/** Runs in every test worker: one client per worker, one session per test, and the matchers. */
const server = inject("channelstack");

let client: Promise<Channelstack> | undefined;
const connected = () => {
  // The worker attaches to the server the global setup found; it never starts one itself.
  process.env.CHANNELSTACK_TOKEN = server.token;
  client ??= connect({ mode: "attach", server: server.url });
  return client;
};

const sessions = new WeakMap<object, Session>();

beforeEach(async (context) => {
  const channelstack = await connected();
  const session = await channelstack.openSession();
  sessions.set(context, session);
  context.channelstack = {
    url: server.url,
    env: () => channelstack.env(),
    quiet: (options = {}) =>
      untilQuiet(() => session.quiet(), { quietFor: server.quietFor, timeout: server.timeout, ...options }),
    reset: () => channelstack.reset(),
  };
  context.slack = await session.slack();
});

afterEach(async (context) => {
  // Closing the session removes everything the test created. Disposing never fails a test.
  await sessions.get(context)?.[Symbol.asyncDispose]();
});

expect.extend(
  // Vitest types a matcher's `this` as its own state; the adapter only needs `isNot` from it.
  Object.fromEntries(
    (Object.keys(matchers) as MatcherName[]).map((name) => [
      name,
      function (this: { isNot: boolean }, subject: unknown, ...args: unknown[]) {
        const state: MatcherState = { isNot: this.isNot, timeout: server.timeout, quietFor: server.quietFor };
        return (matchers[name] as (state: MatcherState, subject: unknown, ...rest: unknown[]) => unknown)(
          state,
          subject,
          ...args,
        );
      },
    ]),
  ) as never,
);
