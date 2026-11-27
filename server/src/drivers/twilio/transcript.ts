import { iso } from "../../core/clock/index.ts";
import { type TranscriptEntry, type TranscriptPrincipal, transcriptText } from "../../core/router/inspect.ts";
import type { TwilioMessageRecord } from "./world.ts";

/**
 * A conversation as a person reads it on their phone: each message's text, oldest first, with its
 * pictures named. Twilio's own answers to `STOP` and `HELP` are Twilio's.
 */
export function renderConversation(
  messages: readonly TwilioMessageRecord[],
  principalOf: (message: TwilioMessageRecord) => TranscriptPrincipal,
) {
  const entries: TranscriptEntry[] = messages.map((message) => ({
    id: message.id,
    author: principalOf(message),
    at: iso(message.createdAt),
    text: [message.body, ...message.media.map((url) => `[media: ${url}]`)].filter((part) => part !== "").join("\n"),
    controls: [],
    edited: false,
    depth: 0,
  }));
  return { entries, text: transcriptText(entries) };
}
