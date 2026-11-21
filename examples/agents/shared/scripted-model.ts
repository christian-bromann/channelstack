/**
 * What the reference agents answer with: a scripted "model", so the same prompt gets the same
 * answer on every run and from every agent. Short answers come from `answer`; long-form requests
 * go through the AI SDK with its own mock model (`writer`), which streams like a real one.
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/** People who may run privileged commands, by Slack user id. */
const ADMINS = new Set((process.env.ADMINS ?? "U0ADMIN01").split(","));

/** The short answer to a prompt from this user. */
export function answer(prompt: string, user: string): string {
  // A mention arrives as <@U…> from Slack itself and as @name from frameworks that resolve it.
  const text = prompt.replace(/<@[A-Z0-9]+>|@[\w-]+/g, "").trim();
  if (/rotate the api keys/i.test(text))
    return ADMINS.has(user) ? "Rotating the API keys now." : "Sorry, you're not allowed to do that.";
  if (/2 \+ 2/.test(text)) return "2 + 2 is 4.";
  return `Here's what I found about "${text}".`;
}

/** Whether a prompt asks for long-form writing, which the agents stream. */
export const wantsWriting = (prompt: string): boolean => /^write /i.test(prompt);

/**
 * The model for long-form requests: it streams a scripted answer in pieces after a moment of
 * "thinking". The pieces are long enough that Slack's clients, which buffer the first 256
 * characters of a stream, show the reply while it is still being written.
 */
export function writer(prompt: string) {
  const subject = prompt.replace(/^write (the |a )?/i, "");
  const pieces = [
    `# ${subject}\n\n`,
    "## What changed\n\nThe delivery queue now retries a slow acknowledgement the way the platform does, signatures are checked before anything else is read, and a rate-limited call waits for as long as it was told to before it tries again. None of this needs a change in your code.\n\n",
    "## What to do\n\nUpdate, run the tests once and read the new failure messages: they name the message a person would still see, which is usually the line you need to fix.\n\n",
    "## Thanks\n\nTo everyone who reported a conversation that went wrong and sent the transcript along with it.\n",
    // A long piece of writing keeps going for a few seconds, long enough for someone to press Stop.
    ...(/\blong\b/i.test(prompt)
      ? Array.from(
          { length: 16 },
          (_, index) => `\n## Appendix ${index + 1}\n\nMore detail, for those who asked for a long one.\n`,
        )
      : []),
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 700,
        chunkDelayInMs: 250,
        chunks: [
          { type: "text-start" as const, id: "answer" },
          ...pieces.map((delta) => ({ type: "text-delta" as const, id: "answer", delta })),
          { type: "text-end" as const, id: "answer" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 180, text: 180, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

/**
 * Send an answer; when Slack refuses it as too long, send the start of it instead. Each agent
 * passes its own way of sending.
 */
export async function sendOrShorten(text: string, send: (text: string) => Promise<unknown>): Promise<void> {
  try {
    await send(text);
  } catch (error) {
    if (!String((error as { data?: { error?: string } }).data?.error ?? error).includes("msg_too_long")) throw error;
    await send(`${text.slice(0, 3000)}…`);
  }
}
