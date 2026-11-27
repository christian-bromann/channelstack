import {
  type DevAdapter,
  type DevApi,
  type DevPlace,
  DevRefusal,
  devRoot,
  type DevTarget,
} from "../../core/dev/index.ts";
import { snowflakeTime } from "./ids.ts";

interface Member {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly isAdmin?: boolean;
}

const segment = encodeURIComponent;

/** The channel whose people a place is: a thread's are its channel's. */
const governing = (place: DevPlace) =>
  place.item.kind === "public_thread" && typeof place.item.parentId === "string" ? place.item.parentId : place.id;

/**
 * Let a person into a channel they don't see yet. Discord's channels here are private to their
 * participants, and only someone who may manage channels adds people: the dev guild's admin, the
 * first person who acted on Discord (`personBody`). A DM stays between its two ends.
 */
async function join(api: DevApi, place: DevPlace, person: Member): Promise<void> {
  if (place.item.kind === "dm") return;
  const people = await api.get<Member[]>("/users");
  if (people.some((known) => known.id === person.id && known.isAdmin)) return;
  const channel = governing(place);
  const members = await api.get<Member[]>(`/channels/${segment(channel)}/members`);
  if (members.some((known) => known.id === person.id)) return;
  const admin = people.find((known) => known.isAdmin);
  if (!admin)
    throw new DevRefusal(`nobody may let ${person.name} into ${place.name}: on Discord an admin adds people.`);
  await api.post(`/users/${segment(admin.id)}/invite`, { participants: [person.id], channel });
}

/**
 * The channel an entry was written in: the place's, or, for an entry under a message that started
 * a thread, that thread's (a channel's transcript shows each thread under its starter).
 */
async function channelOf(api: DevApi, target: DevTarget): Promise<string> {
  if ((target.entries[target.index]?.depth ?? 0) === 0) return target.place.id;
  return (await threadOf(api, target)) ?? target.place.id;
}

/** The thread started from the target's root message, if there is one. */
async function threadOf(api: DevApi, target: DevTarget): Promise<string | undefined> {
  const root = devRoot(target)?.id;
  if (root === undefined || target.place.item.kind !== "text") return undefined;
  const threads = await api.get<Array<{ id: string; starterId?: string }>>(
    `/channels/${segment(target.place.id)}/threads`,
  );
  return threads.find((thread) => thread.starterId === root)?.id;
}

/** Discord in the dev tools: a place is a text channel of the dev guild, made with the person and the bot in it. */
export const discordDev: DevAdapter = {
  place: "channel",
  example: '"#support"',
  resource: "DiscordChannel",
  listing: {
    path: "/channels",
    id: "{id}",
    // A DM has no name; it is named by what it is, and its id tells DMs apart.
    name: ({ name, kind, id }) =>
      kind === "dm"
        ? `Direct message ${String(id)}`
        : kind === "public_thread"
          ? String(name ?? id)
          : `#${String(name ?? id)}`,
    transcript: "/channels/{id}/transcript",
  },
  // The first person on Discord is the guild's admin, who may add the others to a channel.
  personBody: (name, people) => (people.length === 0 ? { name, admin: true } : { name }),
  async create({ api, person, app, name, text }) {
    const channel = await api.post<{ id: string }>("/channels", { name, participants: [person.id, app.id] });
    if (text !== undefined)
      await api.post(`/users/${segment(person.id)}/say`, { text: { content: text }, channel: channel.id });
    return channel;
  },
  enter: ({ api, place, person }) => join(api, place, person),
  async say({ api, place, person, text }) {
    await api.post(`/users/${segment(person.id)}/say`, { text: { content: text }, channel: place.id });
  },
  // Discord's reply: a message in the same channel that quotes the one it answers.
  async reply({ api, target, person, text }) {
    await join(api, target.place, person);
    await api.post(`/users/${segment(person.id)}/reply`, {
      text: { content: text },
      message: { channelId: await channelOf(api, target), id: target.entries[target.index]?.id },
    });
  },
  async react({ api, target, person, emoji }) {
    await join(api, target.place, person);
    // Discord's emoji is the character or its name; `:eyes:` as typed is the name.
    await api.post(`/users/${segment(person.id)}/react`, {
      emoji: emoji.replace(/^:(.+):$/, "$1"),
      message: { channelId: await channelOf(api, target), id: target.entries[target.index]?.id },
    });
  },
  async refs(api, target) {
    const channelId = await channelOf(api, target);
    return {
      DiscordChannel: channelId,
      DiscordMessage: { channelId, id: target.entries[target.index]?.id },
    };
  },
  async thread(api, target) {
    const thread = await threadOf(api, target);
    return thread === undefined ? undefined : `/channels/${segment(thread)}/transcript`;
  },
  // A message's id is a snowflake, which holds when it was written to the millisecond.
  time: (entry) => Date.parse(snowflakeTime(entry.id)),
};
