import { afterEach, expect } from "vitest";

import { restProblems, webhookProblems } from "../../server/test/github-schemas.ts";

/**
 * Exit checks 3.2 and 3.3, for the whole acceptance run: after every test, each REST call the
 * agent made in the test's session and each webhook the fake sent it are held to GitHub's own
 * descriptions. A test that passes with a response GitHub wouldn't give still fails here.
 */
afterEach(async ({ github }) => {
  // A test that never got its fixtures has nothing to check.
  if (!github) return;
  const [calls, deliveries] = await Promise.all([github.calls(), github.deliveries()]);
  const problems = [
    ...calls.flatMap((call) => restProblems(call.method, call.path, call.responseStatus, call.response)),
    ...deliveries.flatMap((delivery) => webhookProblems(delivery.type, delivery.payload)),
  ];
  expect(problems.join("\n"), "what GitHub's schemas say about this test's calls and webhooks").toBe("");
});
