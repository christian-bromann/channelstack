import { alnum, type SecretFormat } from "../../core/secrets/index.ts";

/**
 * The fake OpenAI's key, in the layout of a project key: `sk-proj-`, base 62 and `_`/`-`, with
 * `T3BlbkFJ` ("OpenAI" in base64) in the middle, as OpenAI's keys have it.
 */
export const OPENAI_SECRETS = {
  apiKey: {
    pattern: /^sk-proj-[A-Za-z0-9]{74}T3BlbkFJ[A-Za-z0-9]{74}$/,
    generate: () => `sk-proj-${alnum(74)}T3BlbkFJ${alnum(74)}`,
  },
} as const satisfies Record<string, SecretFormat>;
