import { type Attached, CliError, segment } from "./attach.ts";

interface Person {
  id: string;
  name: string;
  kind: "user" | "app";
}
interface Conversation {
  id: string;
  kind: string;
  name?: string;
}
interface Message {
  channel: string;
  ts: string;
  threadTs?: string;
  author: Person;
}

export interface SlackFlags {
  as?: string | undefined;
  in?: string | undefined;
  thread?: string | undefined;
  on?: string | undefined;
}

/** The Slack part of the dev session: finds people and conversations by name, creating them on first use. */
export async function slackDev(server: Attached) {
  const base = `/sessions/${segment(await server.devSession())}/slack`;
  const get = <T>(path: string) => server.request<T>("GET", `${base}${path}`);
  const post = <T>(path: string, body: unknown) => server.request<T>("POST", `${base}${path}`, body);

  /** `--as <name>`: that person, created the first time the name is used. */
  const person = async (name: string | undefined): Promise<Person> => {
    if (!name) throw new CliError("say who is acting with `--as <name>`, e.g. `--as ana`.");
    const people = await get<Person[]>("/users");
    return people.find((known) => known.name.toLowerCase() === name.toLowerCase()) ?? post<Person>("/users", { name });
  };

  /** `--in "#name"`: that channel with this person and the app in it, created the first time the name is used. */
  const channel = async (name: string | undefined, member: Person): Promise<Conversation> => {
    if (!name) throw new CliError('say where with `--in "#channel"`.');
    const wanted = name.replace(/^#/, "");
    const { app } = await get<{ app: Person }>("");
    const existing = (await get<Conversation[]>("/conversations")).find((known) => known.name === wanted);
    if (!existing) return post<Conversation>("/channels", { name: wanted, participants: [member.id, app.id] });
    await join(existing.id, member);
    return existing;
  };

  /** Let a person into a conversation they aren't in yet: someone who is in it invites them, as on Slack. */
  const join = async (conversation: string, member: Person): Promise<void> => {
    const members = await get<Person[]>(`/conversations/${segment(conversation)}/members`);
    if (members.some((known) => known.id === member.id)) return;
    const host = members.find((known) => known.kind === "user");
    if (!host) throw new CliError(`nobody is in that conversation to invite ${member.name}.`);
    await post(`/users/${segment(host.id)}/invite`, { participants: [member.id], channel: conversation });
  };

  /** The newest message of the most recently active conversation: what `last` means. */
  const last = async (): Promise<Message> => {
    const recent = (await get<Conversation[]>("/conversations")).at(-1);
    if (!recent) throw new CliError("nothing has been said yet. Start with `channelstack slack say`.");
    return get<Message>(`/conversations/${segment(recent.id)}/latest`);
  };

  /** `last`, or `<channel id>:<ts>` as `channelstack show --json` prints them. */
  const message = async (reference: string | undefined, flag: string): Promise<Message> => {
    if (reference === undefined || reference === "last") return last();
    const [channelId, ts] = reference.split(":");
    if (!channelId || !ts) throw new CliError(`${flag} takes \`last\` or \`<channel id>:<ts>\`, got "${reference}".`);
    return get<Message>(`/conversations/${segment(channelId)}/messages/${segment(ts)}`);
  };

  return { get, post, person, channel, join, last, message };
}

const where = (message: Message) => `${message.channel}:${message.ts}`;

/** `channelstack slack <say|reply|react|click|stop> …`: act as a person in the dev session. */
export async function runSlack(server: Attached, action: string | undefined, args: string[], flags: SlackFlags) {
  const slack = await slackDev(server);
  if (action === "say") {
    const [text] = args;
    if (!text) throw new CliError('say what? e.g. `channelstack slack say --as ana --in "#support" "@my-agent hi"`.');
    const actor = await slack.person(flags.as);
    const conversation = await slack.channel(flags.in, actor);
    const said = await slack.post<Message>(`/users/${segment(actor.id)}/say`, {
      message: { text },
      channel: conversation.id,
    });
    return `${actor.name} said it in #${conversation.name} (${where(said)})\n`;
  }
  if (action === "reply") {
    const [text] = args;
    if (!text) throw new CliError('reply what? e.g. `channelstack slack reply --as ben --thread last "and then?"`.');
    const actor = await slack.person(flags.as);
    const target = await slack.message(flags.thread, "--thread");
    await slack.join(target.channel, actor);
    const reply = await slack.post<Message>(`/users/${segment(actor.id)}/reply`, {
      message: { text },
      thread: { channel: target.channel, ts: target.threadTs ?? target.ts },
    });
    return `${actor.name} replied (${where(reply)})\n`;
  }
  if (action === "react") {
    const [emoji] = args;
    if (!emoji) throw new CliError("react with what? e.g. `channelstack slack react --as ben :eyes: --on last`.");
    const actor = await slack.person(flags.as);
    const target = await slack.message(flags.on, "--on");
    await slack.join(target.channel, actor);
    await slack.post(`/users/${segment(actor.id)}/react`, {
      // As typed: the server reads `:eyes:` and `eyes` as the same reaction.
      emoji,
      message: { channel: target.channel, ts: target.ts },
    });
    return `${actor.name} reacted with ${emoji} (${where(target)})\n`;
  }
  if (action === "click") {
    const [label] = args;
    if (!label) throw new CliError('click what? e.g. `channelstack slack click --as ana "Approve"`.');
    const actor = await slack.person(flags.as);
    // The button in the latest message that has it, in the conversation people last spoke in.
    const latest = await slack.last();
    await slack.join(latest.channel, actor);
    await slack.post(`/users/${segment(actor.id)}/click`, { button: { label }, channel: latest.channel });
    return `${actor.name} clicked "${label}"\n`;
  }
  if (action === "stop") {
    const target = await slack.message(flags.thread, "--thread");
    const thread = { channel: target.channel, ts: target.threadTs ?? target.ts };
    // Stop is pressed by `--as`, or by whoever started the thread.
    const root = flags.as === undefined ? await slack.message(`${thread.channel}:${thread.ts}`, "--thread") : undefined;
    if (root && root.author.kind !== "user") throw new CliError("say who presses Stop with `--as <name>`.");
    const actor = root ? root.author : await slack.person(flags.as);
    await slack.post(`/users/${segment(actor.id)}/stop`, { thread });
    return `${actor.name} pressed Stop (${thread.channel}:${thread.ts})\n`;
  }
  throw new CliError(
    `unknown slack command "${action ?? ""}". Try \`say\`, \`reply\`, \`react\`, \`click\` or \`stop\`.`,
  );
}
