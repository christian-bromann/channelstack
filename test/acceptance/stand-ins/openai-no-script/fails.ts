/**
 * Tests that must fail (exit check 13.4), run by `openai-no-script.test.ts`: each plays an agent
 * whose model call goes wrong for want of a script that can answer it. No script answers it, a
 * list ran out, a responder threw or never answered, or the script asked for what the real API
 * can't give. A waiting matcher fails at once instead of timing out; a test that asserts nothing
 * fails when its session closes. Each says why.
 */
import { expect, test } from "vitest";

import { callModel, timed } from "../model-call.ts";

/** What no call in these tests ever sends: a check on it waits until its timeout, unless a model problem stops it. */
const NEVER_SENT = "words this agent never sends to the model";

test("an unscripted call fails a waiting matcher at once", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  const ai = await openai.respond("never used", { when: { text: "something else entirely" } });
  const answer = await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user: channelstack.sessionId });
  expect(answer.status).toBe(400);

  await timed(expect(ai).toHaveAnswered({ timeout: "20s" }));
});

test("an unscripted call fails a test that asserts nothing", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user: channelstack.sessionId });
});

test("a list that runs out fails a waiting matcher at once", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond(["The only answer."]);
  const user = channelstack.sessionId;
  expect((await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user })).status).toBe(200);
  expect((await callModel(openai.baseUrl, key, { text: "and the day before?", user })).status).toBe(400);

  await timed(expect(openai).toHaveSent(NEVER_SENT, { timeout: "20s" }));
});

test("a list that runs out fails a test that asserts nothing", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond(["The only answer."]);
  const user = channelstack.sessionId;
  await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user });
  await callModel(openai.baseUrl, key, { text: "and the day before?", user });
});

test("a responder that throws fails a waiting matcher at once", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond(() => {
    throw new Error("no incident data in this fixture");
  });
  const answer = await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user: channelstack.sessionId });
  expect(answer.status).toBe(400);

  await timed(expect(openai).toHaveSent(NEVER_SENT, { timeout: "20s" }));
});

test("a responder that throws fails a test that asserts nothing", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond(() => {
    throw new Error("no incident data in this fixture");
  });
  await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user: channelstack.sessionId });
});

test("a script problem fails a waiting matcher at once", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond({ toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] });
  const answer = await callModel(openai.baseUrl, key, {
    text: "what broke yesterday?",
    tools: ["lookup_runbook"],
    user: channelstack.sessionId,
  });
  expect(answer.status).toBe(400);

  await timed(expect(openai).toHaveSent(NEVER_SENT, { timeout: "20s" }));
});

test("a script problem fails a test that asserts nothing", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond({ toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] });
  await callModel(openai.baseUrl, key, {
    text: "what broke yesterday?",
    tools: ["lookup_runbook"],
    user: channelstack.sessionId,
  });
});

test("a responder that never answers fails the test with its reason", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond(() => new Promise<string>(() => {}));
  // The server gives up on the test's answer after its 10s, and refuses the call.
  const answer = await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user: channelstack.sessionId });
  expect(answer.status).toBe(400);
}, 30_000);
