import {
  type DevApi,
  devApp,
  devEnsurePlace,
  type DevEntry,
  devEverywhere,
  devFind,
  devPerson,
  devReference,
  DevRefusal,
  devSaid,
  devTarget,
  devTranscript,
} from "../core/dev/index.ts";
import { DEV_CHANNELS } from "../drivers/index.ts";
import { type Attached, CliError, segment } from "./attach.ts";

/** A channel the dev tools act on: its name and title, and its dev adapter. */
export type DevChannel = (typeof DEV_CHANNELS)[number];

/** A channel by its name, or a sentence naming the ones there are. */
export function devChannel(name: string | undefined): DevChannel {
  const channel = DEV_CHANNELS.find((candidate) => candidate.name === name);
  if (!channel) {
    throw new CliError(
      `unknown channel "${name ?? ""}". Try ${DEV_CHANNELS.map((known) => `\`${known.name}\``).join(", ")}.`,
    );
  }
  return channel;
}

/** The channel's control API in the shared `dev` session. */
export async function devApi(server: Attached, channel: string): Promise<DevApi> {
  const base = `/sessions/${segment(await server.devSession())}/${channel}`;
  return {
    get: (path) => server.request("GET", `${base}${path}`),
    post: (path, body) => server.request("POST", `${base}${path}`, body),
  };
}

/** Run a command; the kit's refusals are the CLI's, in the same sentence. */
export async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof DevRefusal ? new CliError(error.message) : error;
  }
}

export interface DevFlags {
  as?: string | undefined;
  in?: string | undefined;
  /** What `reply` answers, `react` reacts to and `show --thread` narrows to: `last` or a reference. */
  to?: string | undefined;
  thread?: string | undefined;
  on?: string | undefined;
  json?: boolean | undefined;
}

/** `say`: a person says something in a place, which is made with them and the app in it the first time. */
export async function runSay(server: Attached, channel: DevChannel, text: string | undefined, flags: DevFlags) {
  return refusing(async () => {
    const { adapter } = channel;
    if (!text)
      throw new CliError(
        `say what? e.g. \`channelstack ${channel.name} say --as ana --in ${adapter.example} "@my-agent hi"\`.`,
      );
    const api = await devApi(server, channel.name);
    const person = await devPerson(api, adapter, flags.as);
    const app = await devApp(api);
    const { place, created } = await devEnsurePlace({ api, adapter, person, app, name: flags.in, text });
    if (!created) await adapter.say({ api, person, app, place, text });
    const said = await devSaid(api, place, person);
    return `${person.name} said it in ${place.name}${said ? ` (${devReference(said)})` : ""}\n`;
  });
}

/** `reply`: a person answers an entry (`last`, the default, or a reference), in its thread where the channel has them. */
export async function runReply(server: Attached, channel: DevChannel, text: string | undefined, flags: DevFlags) {
  return refusing(async () => {
    if (!text)
      throw new CliError(`reply what? e.g. \`channelstack ${channel.name} reply --as ben --to last "and then?"\`.`);
    const api = await devApi(server, channel.name);
    const person = await devPerson(api, channel.adapter, flags.as);
    const target = await devTarget(api, channel.adapter, flags.to ?? flags.thread);
    await channel.adapter.reply({ api, person, app: await devApp(api), target, text });
    const said = await devSaid(api, target.place, person);
    return `${person.name} replied${said ? ` (${devReference(said)})` : ""}\n`;
  });
}

/** `react`: a person reacts to an entry with an emoji, on a channel whose people react. */
export async function runReact(server: Attached, channel: DevChannel, emoji: string | undefined, flags: DevFlags) {
  return refusing(async () => {
    const { react } = channel.adapter;
    if (!react) throw new CliError(`people don't react on ${channel.title}.`);
    if (!emoji)
      throw new CliError(`react with what? e.g. \`channelstack ${channel.name} react --as ben :eyes: --on last\`.`);
    const api = await devApi(server, channel.name);
    const person = await devPerson(api, channel.adapter, flags.as);
    const target = await devTarget(api, channel.adapter, flags.on ?? flags.to);
    await react({ api, person, app: await devApp(api), target, emoji });
    return `${person.name} reacted with ${emoji} (${devReference(target)})\n`;
  });
}

interface Shown {
  readonly entries: readonly DevEntry[];
  readonly text: string;
}

/**
 * `show`: a place as a person reads it. On one channel: the place `--in` names, the thread of the
 * entry `--thread` names (`last` is the newest), or its most recently active place. On none: the
 * most recently active place of every channel's.
 */
export async function runShow(server: Attached, channel: DevChannel | undefined, flags: DevFlags) {
  return refusing(async () => {
    const shown = await (async (): Promise<Shown> => {
      if (channel) {
        const api = await devApi(server, channel.name);
        const { adapter } = channel;
        if (flags.in !== undefined && flags.thread === undefined) {
          const place = await devFind(api, adapter, flags.in);
          if (!place) throw new CliError(`there is no ${adapter.place} "${flags.in}" on ${channel.title} yet.`);
          return devTranscript(api, place.transcript);
        }
        const target = await devTarget(api, adapter, flags.thread ?? flags.in);
        const path = flags.thread === undefined ? undefined : await adapter.thread?.(api, target);
        return devTranscript(api, path ?? target.place.transcript);
      }
      const channels = await Promise.all(
        DEV_CHANNELS.map(async (candidate) => ({ ...candidate, api: await devApi(server, candidate.name) })),
      );
      const last = (await devEverywhere(channels)).at(-1);
      const owner = channels.find((candidate) => candidate.name === last?.channel);
      if (!last?.newest || !owner)
        throw new CliError(
          'nothing has been said yet. Start with `channelstack slack say --as ana --in "#support" "@my-agent hi"`.',
        );
      const newest = { api: owner.api, target: last.newest, channel: owner };
      const path =
        flags.thread === undefined ? undefined : await newest.channel.adapter.thread?.(newest.api, newest.target);
      return devTranscript(newest.api, path ?? newest.target.place.transcript);
    })();
    return flags.json ? `${JSON.stringify(shown.entries, null, 2)}\n` : `${shown.text}\n`;
  });
}
