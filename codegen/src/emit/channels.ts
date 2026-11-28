import type { Ir, IrResource } from "../ir.ts";

/**
 * What every SDK and test framework knows per channel, read once from the IR: the channels, each
 * one's fixture, and the handles of each role. Each emitter writes these in its language, so a new
 * channel needs no hand-written list anywhere.
 */
export interface ChannelGlue {
  /** Each channel's name (`slack`) and type prefix (`Slack`), in the server's order. */
  readonly channels: ReadonlyArray<{ readonly name: string; readonly title: string }>;
  /** The fakes the agent calls that aren't channels (`openai`), each with a fixture. */
  readonly providers: ReadonlyArray<{ readonly name: string; readonly title: string }>;
  /** `SlackFixture`, … */
  readonly fixtures: readonly string[];
  /** The people of every channel (`role: "user"`), its app, and the places things happen in. */
  readonly users: readonly string[];
  readonly apps: readonly string[];
  readonly resources: readonly string[];
  /** `SlackDelivery`, … */
  readonly deliveries: readonly string[];
  /** The fixtures whose `deliveries()` takes filters. */
  readonly filteredDeliveries: readonly string[];
  /** `SlackApiCall`, … */
  readonly apiCalls: readonly string[];
  /** `SlackTranscript`, … */
  readonly transcripts: readonly string[];
  /** Every handle with a `transcript()` read, and whether it takes the viewer (`as`, Slack's). */
  readonly withTranscript: ReadonlyArray<{ readonly name: string; readonly viewer: boolean }>;
  /** Every fixture with a `calls()` read. */
  readonly withCalls: readonly string[];
  /** The people and the app of the channel a type belongs to (`ResendEmail` → `ResendUser`, `ResendApp`). */
  actorsOf(name: string): readonly string[];
}

export function channelGlue(ir: Ir): ChannelGlue {
  const channels = ir.channels.filter((channel) => !channel.internal && !channel.provider);
  const providers = ir.channels.filter((channel) => channel.provider);
  // A provider's types are its own, like echo's: no channel union takes them.
  const internal = ir.channels
    .filter((channel) => channel.internal || channel.provider)
    .map((channel) => channel.title);
  const resources = new Map(ir.resources.map((resource) => [resource.name, resource]));
  const types = new Set(ir.types.map((type) => type.name));
  const ofChannels = (resource: IrResource) =>
    !internal.some((prefix) => resource.name.startsWith(prefix)) &&
    channels.some((channel) => resource.name.startsWith(channel.title));
  /** The channel a type belongs to: the longest title its name starts with, so no title claims another's types. */
  const channelOf = (name: string): string | undefined =>
    channels
      .filter((channel) => name.startsWith(channel.title))
      .reduce<string | undefined>(
        (longest, { title }) => (title.length > (longest?.length ?? 0) ? title : longest),
        undefined,
      );
  /** A resource's methods, its own and those it has from what it extends. */
  const methodsOf = (resource: IrResource): IrResource["methods"] => {
    const parent = resource.extends === undefined ? undefined : resources.get(resource.extends);
    return [...resource.methods, ...(parent ? methodsOf(parent) : [])];
  };
  const named = (suffix: string, exists: (name: string) => boolean) =>
    channels.map((channel) => `${channel.title}${suffix}`).filter(exists);
  const role = (wanted: NonNullable<IrResource["role"]>) =>
    ir.resources
      .filter((resource) => resource.role === wanted && ofChannels(resource))
      .map((resource) => resource.name);
  const fixtures = named("Fixture", (name) => resources.has(name));
  return {
    channels: channels.map(({ name, title }) => ({ name, title })),
    providers: providers.map(({ name, title }) => ({ name, title })),
    fixtures,
    users: role("user"),
    apps: role("app"),
    resources: role("resource"),
    deliveries: named("Delivery", (name) => resources.has(name)),
    filteredDeliveries: fixtures.filter((name) => {
      const method = methodsOf(resources.get(name) as IrResource).find((candidate) => candidate.name === "deliveries");
      return method !== undefined && method.options.length > 0;
    }),
    apiCalls: named("ApiCall", (name) => types.has(name)),
    transcripts: named("Transcript", (name) => types.has(name)),
    withTranscript: ir.resources.filter(ofChannels).flatMap((resource) => {
      const read = methodsOf(resource).find((method) => method.name === "transcript" && method.args.length === 0);
      return read ? [{ name: resource.name, viewer: read.options.some((option) => option.name === "as") }] : [];
    }),
    withCalls: fixtures.filter((name) =>
      methodsOf(resources.get(name) as IrResource).some((method) => method.name === "calls"),
    ),
    actorsOf: (name) => {
      const channel = channelOf(name);
      const ofRole = (wanted: "user" | "app") =>
        ir.resources
          .filter((resource) => resource.role === wanted && channelOf(resource.name) === channel)
          .map((resource) => resource.name);
      return channel === undefined ? [] : [...ofRole("user"), ...ofRole("app")];
    },
  };
}
