import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createOpenAIApi } from "./api.ts";
import { OPENAI_IDS } from "./ids.ts";
import { registerOpenAIRoutes } from "./routes.ts";
import { OPENAI_SECRETS } from "./secrets.ts";
import { OpenAIWorld } from "./world.ts";

/**
 * The fake OpenAI (decision 0029): Chat Completions, Responses and Conversations at
 * `openai.localhost`, scripted per test. A provider, not a channel: it has no people, apps,
 * deliveries or transcripts, and its calls are attributed to sessions from what they say.
 */
export const openai: DriverDefinition = {
  name: "openai",
  title: "OpenAI",
  provider: true,
  ids: OPENAI_IDS,
  tokenPatterns: [/sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  hosts: ["api.openai.com"],
  secrets: { apiKey: OPENAI_SECRETS.apiKey },
  create(context): Driver {
    const world = new OpenAIWorld({
      ids: context.ids,
      clock: context.clock,
      timers: context.timers,
      attribution: context.attribution,
      place: (attribution) => context.place(attribution),
    });
    const api = createOpenAIApi(context, world);
    // The SDKs take the base URL with its `/v1`.
    const baseUrl = () => `${context.apiUrl()}/v1`;
    return {
      name: "openai",
      fake: {
        api,
        seed: () => world.reset(),
        release: (session) => world.release(session),
      },
      routes: (router) =>
        registerOpenAIRoutes(router, {
          world,
          ids: context.ids,
          timers: context.timers,
          baseUrl,
          scrub: (value) => context.scrub(value),
          findSecrets: (text) => context.findSecrets(text),
        }),
      capabilities: () => ({}),
      openWork: (session) => world.openWork(session),
      // A problem can quote what the agent sent the model: scrubbed, as everything the control API returns.
      problems: (session) => context.scrub(world.problems(session)),
      // What the agent needs: the official SDKs read both by themselves.
      env: () => ({ OPENAI_BASE_URL: baseUrl(), OPENAI_API_KEY: context.secret("apiKey") }),
    };
  },
};
