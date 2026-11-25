import { type Attached, CliError, segment } from "./attach.ts";

/** The channels whose deliveries the dev session shows. */
export const CHANNELS = ["slack", "github", "linear", "notion"] as const;
type Channel = (typeof CHANNELS)[number];

interface Delivery {
  id: string;
  type: string;
  /** Slack's inner event type, GitHub's and Linear's action. */
  eventType?: string;
  action?: string;
  status: string;
  attempts: Array<{ responseStatus?: number }>;
}

function channelOf(value: string | undefined): Channel {
  if (CHANNELS.includes(value as Channel)) return value as Channel;
  throw new CliError(`say which channel: ${CHANNELS.join(", ")}${value ? `, not "${value}"` : ""}.`);
}

/**
 * `channelstack deliveries <channel>`: what the dev session sent the agent, newest last, one line
 * each: the delivery's id (for `redeliver`), what it was, how it ended and each attempt's status.
 */
export async function runDeliveries(server: Attached, channel: string | undefined): Promise<string> {
  const driver = channelOf(channel);
  const session = segment(await server.devSession());
  const deliveries = await server.request<Delivery[]>("GET", `/sessions/${session}/${driver}/deliveries`);
  if (deliveries.length === 0) return `Nothing was delivered to the agent on ${driver} yet.\n`;
  return deliveries
    .map((delivery) => {
      const what = [delivery.type, delivery.eventType ?? delivery.action].filter(Boolean).join(" ");
      const attempts = delivery.attempts.map((attempt) => attempt.responseStatus ?? "-").join(", ");
      return `${delivery.id}  ${what}  ${delivery.status}  (attempts: ${attempts})\n`;
    })
    .join("");
}

/**
 * `channelstack redeliver <channel> <delivery>`: send a delivery to the agent again, the way the
 * platform does: Slack retries it (with its retry headers), the others redeliver it.
 */
export async function runRedeliver(
  server: Attached,
  channel: string | undefined,
  delivery: string | undefined,
): Promise<string> {
  const driver = channelOf(channel);
  if (!delivery) throw new CliError(`say which delivery: an id that \`channelstack deliveries ${driver}\` printed.`);
  const session = segment(await server.devSession());
  const path = `/sessions/${session}/${driver}/deliveries/${segment(delivery)}`;
  await server.request("POST", driver === "slack" ? `${path}/retry` : `${path}/redeliver`, {});
  return `${driver === "slack" ? "Retried" : "Redelivered"} ${delivery}\n`;
}
