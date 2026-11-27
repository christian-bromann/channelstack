/**
 * Two tests that must fail (exit check 13.4), run by `openai-no-script.test.ts`: each plays an
 * agent whose model call no script answers. One waits in a matcher, which fails at once instead
 * of timing out; the other asserts nothing, and fails when its session closes.
 */
import { expect, test } from "vitest";

/** A model call as an agent makes one, tagged with the test's session, that no script answers. */
async function unscripted(baseUrl: string, key: string, session: string): Promise<number> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5",
      user: session,
      messages: [{ role: "user", content: "what broke yesterday?" }],
    }),
  });
  return response.status;
}

test("a waiting matcher fails at once", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  const ai = await openai.respond("never used", { when: { text: "something else entirely" } });
  expect(await unscripted(openai.baseUrl, key, channelstack.sessionId)).toBe(400);

  await expect(ai).toHaveAnswered({ timeout: "20s" });
});

test("a test that asserts nothing still fails", async ({ openai, channelstack }) => {
  const key = (await channelstack.env()).OPENAI_API_KEY ?? "";
  await unscripted(openai.baseUrl, key, channelstack.sessionId);
});
