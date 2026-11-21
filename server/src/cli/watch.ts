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
  driver: string;
  kind: "action" | "delivery" | "delivery_attempt" | "api_call";
  data: Record<string, unknown>;
}

/** One line per event: what went to the agent (→) and what the agent called (←). */
function line(event: LogEvent, deliveries: Map<unknown, unknown>): string | undefined {
  const time = event.at.slice(11, 23);
  const { data } = event;
  // A delivery is announced once with its type; each attempt then says how it went.
  if (event.kind === "delivery") deliveries.set(data.id, data.eventType ?? data.type);
  if (event.kind === "delivery_attempt") {
    const outcome = data.status === "acknowledged" ? `${data.responseStatus}` : String(data.status);
    const retry = data.number === 1 ? "" : ` (attempt ${data.number})`;
    return `${time} → ${event.driver} ${deliveries.get(data.id) ?? "event"}${retry}  ${outcome}`;
  }
  if (event.kind === "api_call") {
    const outcome = data.error === undefined ? `${data.responseStatus}` : `${data.responseStatus} ${data.error}`;
    return `${time} ← ${event.driver} ${data.operation}  ${outcome}`;
  }
  return undefined;
}

/**
 * `channelstack tail`: the dev session's events as they happen: deliveries to the agent and the
 * agent's API calls. `--once` prints what is there and returns.
 */
export async function runTail(server: Attached, flags: { once?: boolean | undefined }, write: (text: string) => void) {
  const session = segment(await server.devSession());
  const deliveries = new Map<unknown, unknown>();
  let cursor: string | undefined;
  for (;;) {
    const page = await server.request<{ events: LogEvent[]; cursor: string }>(
      "GET",
      `/sessions/${session}/events${cursor === undefined ? "" : `?since=${segment(cursor)}`}`,
    );
    cursor = page.cursor;
    for (const event of page.events) {
      const text = line(event, deliveries);
      if (text !== undefined) write(`${text}\n`);
    }
    if (flags.once) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
