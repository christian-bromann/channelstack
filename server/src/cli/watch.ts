import { type Attached, segment } from "./attach.ts";

interface LogEvent {
  at: string;
  summary?: { text: string; outcome: string };
}

/**
 * The dev session's events after `cursor` (all of them without one), one line per event the server
 * summarizes: what went to the agent (→) and what the agent called (←). Returns where to read on from.
 */
export async function readEvents(server: Attached, cursor?: string): Promise<{ text: string; cursor: string }> {
  const session = segment(await server.devSession());
  const page = await server.request<{ events: LogEvent[]; cursor: string }>(
    "GET",
    `/sessions/${session}/events${cursor === undefined ? "" : `?since=${segment(cursor)}`}`,
  );
  const lines = page.events.flatMap(({ at, summary }) =>
    summary ? [`${at.slice(11, 23)} ${summary.text}  ${summary.outcome}\n`] : [],
  );
  return { text: lines.join(""), cursor: page.cursor };
}

/**
 * `channelstack tail`: the dev session's events as they happen: deliveries to the agent and the
 * agent's API calls. `--once` prints what is there and returns.
 */
export async function runTail(server: Attached, flags: { once?: boolean | undefined }, write: (text: string) => void) {
  let cursor: string | undefined;
  for (;;) {
    const read = await readEvents(server, cursor);
    cursor = read.cursor;
    if (read.text) write(read.text);
    if (flags.once) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
