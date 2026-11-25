import { afterEach, beforeEach, expect, type TestContext } from "vitest";

import { refusedLive, withoutLiveSkips, type WithSession } from "../../integrations/vitest/refused.ts";
import { restProblems, webhookProblems } from "../../server/test/github-schemas.ts";

/**
 * Exit checks 3.2 and 3.3, for the whole acceptance run: after every test, each REST call the
 * agent made in the test's session and each webhook the fake sent it are held to GitHub's own
 * descriptions. A test that passes with a response GitHub wouldn't give still fails here.
 */
/** The newest of the App's session-less calls on record when each test began, by its number. */
const before = new WeakMap<object, number>();
/** A call's number in its log (`call_12` → 12): what came after a call has a higher one. */
const callNumber = (call: { id: string }) => Number(call.id.slice("call_".length));

beforeEach(async ({ github, task, channelstackSession }: TestContext & WithSession) => {
  if (!github || refusedLive(github)) return;
  const calls = await withoutLiveSkips({ channelstackSession }, () => github.appCalls());
  // By id, not by count: the App's log keeps only its newest calls, so its length stops growing.
  if (calls) before.set(task, Math.max(0, ...calls.map(callNumber)));
});

afterEach(async ({ github, task, channelstackSession }: TestContext & WithSession) => {
  // A test that never got its fixtures has nothing to check, and nor has a live GitHub: no fake answered.
  if (!github || refusedLive(github)) return;
  // The App's own endpoints belong to no session: what was called there since this test began is checked too.
  const read = await withoutLiveSkips({ channelstackSession }, () =>
    Promise.all([github.calls(), github.appCalls(), github.deliveries()]),
  );
  if (!read) return;
  const [inSession, aboutNoRepo, deliveries] = read;
  const calls = [...inSession, ...aboutNoRepo.filter((call) => callNumber(call) > (before.get(task) ?? 0))];
  const problems = [
    ...calls.flatMap((call) => restProblems(call.method, call.path, call.responseStatus, call.response)),
    ...deliveries.flatMap((delivery) => webhookProblems(delivery.type, delivery.payload)),
  ];
  expect(problems.join("\n"), "what GitHub's schemas say about this test's calls and webhooks").toBe("");
});
