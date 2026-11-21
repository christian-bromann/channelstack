import type { EchoMessage } from "./world.ts";

/** A room reduced to what a person would read, in the shape every channel's transcript has (`api/common.d.ts`). */
export function renderTranscript(messages: readonly EchoMessage[]) {
  return {
    entries: messages.map((message) => ({
      id: message.id,
      author: message.author,
      at: message.at,
      text: message.text,
      controls: [] as string[],
      edited: false,
      depth: 0,
    })),
  };
}
