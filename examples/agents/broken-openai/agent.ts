/**
 * The agent on the fake OpenAI with one switchable fault per model check. With `BROKEN` unset it
 * does everything right; with `BROKEN=slack.model-error` (any id of `SLACK_MODEL_CHECKS`) it has
 * exactly the bug that check exists to catch. The test suite uses it to prove each check fails
 * when it should.
 */
import OpenAI from "openai";

import { createApp, listen } from "../shared/bolt.ts";
import { modelAgent } from "../shared/model-agent.ts";
import { chatModel } from "../shared/openai-chat.ts";

const fault = process.env.BROKEN ?? "";
// Bug (with slack.model-retry): retries a failed call itself, instead of letting the SDK do it quietly.
const openai = new OpenAI(fault === "slack.model-retry" ? { maxRetries: 0 } : {});
const app = createApp();
modelAgent(app, chatModel(openai), new Set(fault === "" ? [] : [fault]));
await listen(app);
