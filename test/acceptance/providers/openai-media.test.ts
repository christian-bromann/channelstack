import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

// Exit check 14.5, in TypeScript: a `MediaSource` given as a path is read here, in the test
// process, and the fake serves those bytes. The test plays the agent, calling the fake's Images
// API as the official SDK does, tagged with its session so the call is its own.
const CHART = new URL("../examples/fixtures/chart.png", import.meta.url);

describe("media a test hands over", () => {
  test("an image given as a path is served byte for byte", async ({ channelstack, openai }) => {
    const { OPENAI_API_KEY } = await channelstack.env();
    await openai.respond({ image: "../examples/fixtures/chart.png" }, { when: { endpoint: "images.generations" } });

    const response = await fetch(`${openai.baseUrl}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt: "this week's deploys", user: channelstack.sessionId }),
    });

    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { b64_json: string }[] };
    expect(Buffer.from(data[0]?.b64_json ?? "", "base64")).toEqual(readFileSync(CHART));
  });
});
