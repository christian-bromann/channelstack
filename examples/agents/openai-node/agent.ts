/**
 * A reference agent: a Bolt app that answers through the official `openai` SDK, on Chat
 * Completions, streaming. It has no channelstack code in it: the SDK reads `OPENAI_BASE_URL` and
 * `OPENAI_API_KEY` by itself (`channelstack env` prints them), so in tests it talks to the fake
 * OpenAI, and to OpenAI itself when they are unset.
 */
import OpenAI from "openai";

import { createApp, listen } from "../shared/bolt.ts";
import { modelAgent } from "../shared/model-agent.ts";
import { chatModel } from "../shared/openai-chat.ts";

/**
 * A used-up quota (429 with `type: "insufficient_quota"`: a plan or spend limit) doesn't clear by
 * trying again, but the SDK retries every 429. This marks such an answer `x-should-retry: false`,
 * the header the SDK obeys, so it gives up at once and the person hears so; every other answer
 * reaches the SDK as it came, and the SDK retries what can clear.
 */
const quotaIsFinal = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);
  if (response.status !== 429) return response;
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: { type?: string } } | undefined;
  if (body?.error?.type !== "insufficient_quota") return response;
  const headers = new Headers(response.headers);
  headers.set("x-should-retry", "false");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const app = createApp();
modelAgent(app, chatModel(new OpenAI({ fetch: quotaIsFinal })));
await listen(app);
