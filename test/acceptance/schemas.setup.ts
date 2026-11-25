import { afterEach, beforeEach, expect } from "vitest";

import { refusedLive, withoutLiveSkips, type WithSession } from "../../integrations/vitest/refused.ts";
import { ChannelstackError } from "../../sdks/typescript/client.ts";
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
type Context = { task: object } & WithSession;

/**
 * The channel's fixture in the test's session, opened the way the channel's own fixture is
 * (Vitest's hooks name the fixtures they use, and these hooks serve every channel). Nothing when
 * the channel is refused here (live, without its backend or credentials): no fake answered there.
 */
async function fixtureOf({ channelstackSession: session }: Context, channel: string): Promise<Fixture | undefined> {
  const open = (session as unknown as Record<string, (() => Promise<Fixture>) | undefined> | undefined)?.[channel];
  if (!session || !open) return undefined;
  try {
    const fixture = await open.call(session);
    return refusedLive(fixture) ? undefined : fixture;
  } catch (error) {
    if (error instanceof ChannelstackError) return undefined;
    throw error;
  }
}

/** The newest session-less call on record when each test began, per channel, by its number. */
const before = new WeakMap<object, Map<string, number>>();
/** A call's number in its log (`call_12` → 12): what came after a call has a higher one. */
const callNumber = (call: { id: string }) => Number(call.id.slice("call_".length));

beforeEach(async ({ task, channelstackSession }: Context) => {
  const context = { task, channelstackSession };
  const started = new Map<string, number>();
  for (const [channel, schemas] of Object.entries(SCHEMAS)) {
    if (!schemas.sessionless) continue;
    const fixture = await fixtureOf(context, channel);
    if (!fixture) continue;
    const read = fixture[schemas.sessionless];
    const calls = read && (await withoutLiveSkips(context, () => read.call(fixture)));
    // By id, not by count: the log keeps only its newest calls, so its length stops growing.
    if (calls) started.set(channel, Math.max(0, ...calls.map(callNumber)));
  }
  before.set(context.task, started);
});

afterEach(async ({ task, channelstackSession }: Context) => {
  const context = { task, channelstackSession };
  const problems: string[] = [];
  for (const [channel, schemas] of Object.entries(SCHEMAS)) {
    // A channel refused here has nothing to check, and nor has a live platform: no fake answered.
    const fixture = await fixtureOf(context, channel);
    if (!fixture) continue;
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
