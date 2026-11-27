import { type DevAdapter, type DevApi, type DevPlace, DevRefusal, devRoot } from "../../core/dev/index.ts";

interface Member {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

const segment = encodeURIComponent;

/** Let a person into a conversation they aren't in yet: someone who is in it invites them, as on Slack. */
async function join(api: DevApi, place: DevPlace, person: Member): Promise<void> {
  const members = await api.get<Member[]>(`/conversations/${segment(place.id)}/members`);
  if (members.some((known) => known.id === person.id)) return;
  const host = members.find((known) => known.kind === "user");
  if (!host) throw new DevRefusal(`nobody is in ${place.name} to invite ${person.name}.`);
  await api.post(`/users/${segment(host.id)}/invite`, { participants: [person.id], channel: place.id });
}

/** Slack in the dev tools: a place is a channel, made with the person and the bot in it. */
export const slackDev: DevAdapter = {
  place: "channel",
  example: '"#support"',
  resource: "SlackConversation",
  listing: {
    path: "/conversations",
    id: "{id}",
    name: ["#{name}", "{id}"],
    transcript: "/conversations/{id}/transcript",
  },
  personBody: (name) => ({ name }),
  async create({ api, person, app, name, text }) {
    const channel = await api.post<{ id: string }>("/channels", { name, participants: [person.id, app.id] });
    if (text !== undefined)
      await api.post(`/users/${segment(person.id)}/say`, { message: { text }, channel: channel.id });
    return channel;
  },
  enter: ({ api, place, person }) => join(api, place, person),
  async say({ api, place, person, text }) {
    await api.post(`/users/${segment(person.id)}/say`, { message: { text }, channel: place.id });
  },
  async reply({ api, target, person, text }) {
    await join(api, target.place, person);
    await api.post(`/users/${segment(person.id)}/reply`, {
      message: { text },
      thread: { channel: target.place.id, ts: devRoot(target).id },
    });
  },
  async react({ api, target, person, emoji }) {
    await join(api, target.place, person);
    // As typed: the server reads `:eyes:` and `eyes` as the same reaction.
    await api.post(`/users/${segment(person.id)}/react`, {
      emoji,
      message: { channel: target.place.id, ts: target.entries[target.index]?.id },
    });
  },
  async refs(_api, target) {
    const channel = target.place.id;
    return {
      SlackConversation: channel,
      SlackMessage: { channel, ts: target.entries[target.index]?.id },
      SlackThread: { channel, ts: devRoot(target).id },
    };
  },
  thread: async (_api, target) =>
    `/conversations/${segment(target.place.id)}/threads/${segment(devRoot(target).id)}/transcript`,
  // A conversation's transcript lists replies under their thread: the server knows which message is newest.
  async newest(api, place) {
    return (await api.get<{ ts: string }>(`/conversations/${segment(place.id)}/latest`)).ts;
  },
};
