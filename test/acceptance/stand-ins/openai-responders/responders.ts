/**
 * Responders from the TypeScript SDK (exit check 13.6), run by `openai-no-script.test.ts`: each
 * test plays the agent, calling the fake OpenAI the way the official SDK does, and answers the call
 * with a function. One that throws or never answers is in `openai-no-script/fails.ts`.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "vitest";

import { callModel } from "../model-call.ts";

test("a responder answers from the request and its context", async ({ slack, openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben" });
  // Each writes to the agent; nothing listens, so this test answers for it.
  await ana.say("the web deploy is red again", { to: slack.app });
  await ben.say("the nightly migration never finished", { to: slack.app });
  const ai = await openai.respond(
    (request) =>
      `${request.context.from?.id === ana.id ? "Ana" : request.context.from?.id === ben.id ? "Ben" : "Nobody"} asked in ${request.context.channel ?? "no channel"}: ${request.lastUserText}`,
  );

  // No tag: the text the agent was sent is what gives the call, and its context, to this test.
  const forAna = await callModel(openai.baseUrl, key, { text: "Ana wrote: the web deploy is red again" });
  const forBen = await callModel(openai.baseUrl, key, { text: "Ben wrote: the nightly migration never finished" });

  expect(forAna.body.choices?.[0]?.message.content, JSON.stringify(forAna.body)).toBe(
    "Ana asked in slack: Ana wrote: the web deploy is red again",
  );
  expect(forBen.body.choices?.[0]?.message.content).toBe(
    "Ben asked in slack: Ben wrote: the nightly migration never finished",
  );
  await expect(ai).toHaveAnswered();
  expect((await ai.calls()).map((call) => call.request.context.from?.id)).toEqual([ana.id, ben.id]);
});

test("firstToken holds with a slow responder: it counts from the call's arrival", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  const user = channelstack.sessionId;
  await openai.respond(
    async () => {
      await sleep(800);
      return "Two incidents yesterday.";
    },
    { timing: { firstToken: "1500ms" } },
  );

  const answer = await callModel(openai.baseUrl, key, { text: "what broke yesterday?", user });

  expect(answer.body.choices?.[0]?.message.content).toBe("Two incidents yesterday.");
  // Not before firstToken, and the responder's time is part of it, not added to it.
  expect(answer.ms).toBeGreaterThanOrEqual(1500);
  expect(answer.ms).toBeLessThan(2000);
});

test("a responder slower than firstToken delays the answer by its own time only", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await openai.respond(
    async () => {
      await sleep(1500);
      return "Still looking.";
    },
    { timing: { firstToken: "800ms" } },
  );

  const answer = await callModel(openai.baseUrl, key, { text: "anything new?", user: channelstack.sessionId });

  expect(answer.body.choices?.[0]?.message.content).toBe("Still looking.");
  expect(answer.ms).toBeGreaterThanOrEqual(1500);
  expect(answer.ms).toBeLessThan(2000);
});
