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

const app = createApp();
modelAgent(app, chatModel(new OpenAI()));
await listen(app);
