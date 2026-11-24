import { afterEach, expect } from "vitest";

import { refusedLive } from "../../integrations/vitest/refused.ts";
import { linearResponseProblems, linearWebhookProblems } from "../../server/test/linear-schema.ts";

/**
 * Exit check 4.3, for the whole acceptance run: after every test, each GraphQL answer the agent
 * got in the test's session and each webhook the fake sent it are held to Linear's own schema. A
 * test that passes with an answer Linear wouldn't give still fails here.
 */
afterEach(async ({ linear }) => {
  // A test that never got its fixtures has nothing to check.
  if (!linear || refusedLive(linear)) return;
  const [calls, deliveries] = await Promise.all([linear.calls(), linear.deliveries()]);
  const problems = [
    ...calls.flatMap((call) =>
      linearResponseProblems(call.request as { query: string }, call.responseStatus, call.response),
    ),
    ...deliveries.flatMap((delivery) => linearWebhookProblems(delivery.type, delivery.payload)),
  ];
  expect(problems.join("\n"), "what Linear's schema says about this test's calls and webhooks").toBe("");
});
