import { CHANNEL_NAMES, CHANNELS } from "../drivers/index.ts";
import { type Attached, CliError, segment } from "./attach.ts";

type Channel = string;

/** The channels whose deliveries the dev session shows: every channel, as a list `z.enum` takes. */
export const DELIVERY_CHANNELS = CHANNEL_NAMES as [string, ...string[]];

interface Delivery {
  id: string;
  type: string;
  /** Slack's inner event type, GitHub's and Linear's action. */
  eventType?: string;
  action?: string;
  status: string;
  attempts: Array<{ responseStatus?: number; sentAt?: string }>;
}

const isChannel = (value: string | undefined): value is Channel => value !== undefined && CHANNEL_NAMES.includes(value);

function channelOf(value: string): Channel {
  if (isChannel(value)) return value;
  throw new CliError(`say which channel: ${CHANNEL_NAMES.join(", ")}, not "${value}".`);
}

/** A channel's deliveries in the dev session, oldest first. */
async function deliveriesOf(server: Attached, channel: Channel): Promise<Delivery[]> {
  const session = segment(await server.devSession());
  return server.request<Delivery[]>("GET", `/sessions/${session}/${channel}/deliveries`);
}

/** Every channel's deliveries. A channel this server can't list (live, say) is left out, not an error. */
async function allDeliveries(server: Attached): Promise<Array<{ channel: Channel; delivery: Delivery }>> {
  const listed = await Promise.all(
    CHANNEL_NAMES.map(async (channel) => {
      try {
        return (await deliveriesOf(server, channel)).map((delivery) => ({ channel, delivery }));
      } catch (error) {
        if (error instanceof CliError) return [];
        throw error;
      }
    }),
  );
  return listed.flat();
}

const sentAt = (delivery: Delivery) => delivery.attempts[0]?.sentAt ?? "";

function line(delivery: Delivery): string {
  const what = [delivery.type, delivery.eventType ?? delivery.action].filter(Boolean).join(" ");
  const attempts = delivery.attempts.map((attempt) => attempt.responseStatus ?? "-").join(", ");
  return `${delivery.id}  ${what}  ${delivery.status}  (attempts: ${attempts})\n`;
}

/**
 * `channelstack deliveries [<channel>]`: what the dev session sent the agent, oldest first, one line
 * each: the delivery's id (for `redeliver`), what it was, how it ended and each attempt's status.
 * Without a channel, every channel's, each line starting with its channel.
 */
export async function runDeliveries(server: Attached, channel: string | undefined): Promise<string> {
  if (channel !== undefined) {
    const driver = channelOf(channel);
    const deliveries = await deliveriesOf(server, driver);
    if (deliveries.length === 0) return `Nothing was delivered to the agent on ${driver} yet.\n`;
    return deliveries.map(line).join("");
  }
  const every = (await allDeliveries(server)).sort((a, b) => sentAt(a.delivery).localeCompare(sentAt(b.delivery)));
  if (every.length === 0) return "Nothing was delivered to the agent yet.\n";
  return every.map(({ channel, delivery }) => `${channel.padEnd(7)}${line(delivery)}`).join("");
}

/**
 * `channelstack redeliver [<channel>] [last|<delivery>]`: send a delivery to the agent again, the way
 * the platform does: Slack retries it (with its retry headers), the others redeliver it. `last` (the
 * default) is the newest delivery, of that channel or of any; an id is found in whichever channel has it.
 */
export async function runRedeliver(server: Attached, args: readonly string[]): Promise<string> {
  const [first, second] = args;
  const channel = isChannel(first) ? first : undefined;
  const wanted = (channel ? second : first) ?? "last";
  if (channel === undefined && second !== undefined) channelOf(first ?? "");
  const candidates =
    channel === undefined
      ? await allDeliveries(server)
      : (await deliveriesOf(server, channel)).map((delivery) => ({ channel, delivery }));
  const found =
    wanted === "last"
      ? candidates.sort((a, b) => sentAt(a.delivery).localeCompare(sentAt(b.delivery))).at(-1)
      : candidates.find(({ delivery }) => delivery.id === wanted);
  if (!found) {
    throw new CliError(
      wanted === "last"
        ? `nothing was delivered to the agent${channel ? ` on ${channel}` : ""} yet.`
        : `no delivery ${wanted}${channel ? ` on ${channel}` : ""}. \`channelstack deliveries\` lists them.`,
    );
  }
  const session = segment(await server.devSession());
  const path = `/sessions/${session}/${found.channel}/deliveries/${segment(found.delivery.id)}`;
  // Each platform's own word for it: Slack retries, the others redeliver.
  const again = CHANNELS.find((definition) => definition.name === found.channel)?.redeliver ?? "redeliver";
  await server.request("POST", `${path}/${again}`, {});
  return `${again === "retry" ? "Retried" : "Redelivered"} ${found.delivery.id} (${found.channel})\n`;
}
