import { type Attached, segment } from "./attach.ts";
import { slackDev } from "./slack.ts";

interface Transcript {
  entries: unknown[];
  text: string;
}

/**
 * `channelstack show`: the most recently active conversation as a person would read it;
 * `--thread last` narrows it to the thread of the newest message; `--json` prints the entries.
 */
export async function runShow(server: Attached, flags: { thread?: string | undefined; json?: boolean | undefined }) {
  const slack = await slackDev(server);
  const newest = flags.thread === undefined ? await slack.last() : await slack.message(flags.thread, "--thread");
  const conversation = `/conversations/${segment(newest.channel)}`;
  const transcript = await slack.get<Transcript>(
    flags.thread === undefined
      ? `${conversation}/transcript`
      : `${conversation}/threads/${segment(newest.threadTs ?? newest.ts)}/transcript`,
  );
  return flags.json ? `${JSON.stringify(transcript.entries, null, 2)}\n` : `${transcript.text}\n`;
}

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
