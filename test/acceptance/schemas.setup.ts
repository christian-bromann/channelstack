import { afterEach, beforeEach, expect, type TestContext } from "vitest";

import { refusedLive, withoutLiveSkips, type WithSession } from "../../integrations/vitest/refused.ts";
import { type CheckedCall, SCHEMAS } from "../../server/test/schemas/index.ts";

/**
 * Exit checks 3.2, 3.3 and 4.3 (and each channel's after them), for the whole acceptance run: after
 * every test, each API call the agent made in the test's session and each webhook the fake sent it
 * are held to the platform's own description. A test that passes with an answer the platform
 * wouldn't give still fails here.
 */
type Fixture = {
  calls(): Promise<CheckedCall[]>;
  deliveries(): Promise<Array<{ type: string; payload: unknown }>>;
  appCalls?(): Promise<CheckedCall[]>;
};
const fixtureOf = (context: TestContext, channel: string) =>
  (context as unknown as Record<string, Fixture | undefined>)[channel];

/** The newest session-less call on record when each test began, per channel, by its number. */
const before = new WeakMap<object, Map<string, number>>();
/** A call's number in its log (`call_12` → 12): what came after a call has a higher one. */
const callNumber = (call: { id: string }) => Number(call.id.slice("call_".length));

beforeEach(async (context: TestContext & WithSession) => {
  const started = new Map<string, number>();
  for (const [channel, schemas] of Object.entries(SCHEMAS)) {
    const fixture = fixtureOf(context, channel);
    if (!schemas.sessionless || !fixture || refusedLive(fixture)) continue;
    const read = fixture[schemas.sessionless];
    const calls = read && (await withoutLiveSkips(context, () => read.call(fixture)));
    // By id, not by count: the log keeps only its newest calls, so its length stops growing.
    if (calls) started.set(channel, Math.max(0, ...calls.map(callNumber)));
  }
  before.set(context.task, started);
});

afterEach(async (context: TestContext & WithSession) => {
  const problems: string[] = [];
  for (const [channel, schemas] of Object.entries(SCHEMAS)) {
    // A test that never got its fixtures has nothing to check, and nor has a live platform: no fake answered.
    const fixture = fixtureOf(context, channel);
    if (!fixture || refusedLive(fixture)) continue;
    const sessionless = schemas.sessionless ? fixture[schemas.sessionless] : undefined;
    const read = await withoutLiveSkips(context, () =>
      Promise.all([fixture.calls(), fixture.deliveries(), sessionless ? sessionless.call(fixture) : []]),
    );
    if (!read) continue;
    const [inSession, deliveries, aboutNothing] = read;
    const since = before.get(context.task)?.get(channel) ?? 0;
    const calls = [...inSession, ...aboutNothing.filter((call) => callNumber(call) > since)];
    problems.push(
      ...calls.flatMap((call) => schemas.call(call)),
      ...deliveries.flatMap((delivery) => schemas.webhook(delivery.type, delivery.payload)),
    );
  }
  expect(problems.join("\n"), "what the platforms' schemas say about this test's calls and webhooks").toBe("");
});
