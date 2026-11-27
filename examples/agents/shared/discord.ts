/**
 * What the Discord agents do, written once against discord.js as its guide shows: the bot hears
 * people over the Gateway and answers with `message.reply`; slash commands and buttons arrive as
 * interactions over HTTP, checked with `discord-interactions`'s `verifyKey`, or over the Gateway when
 * the app has no interactions endpoint. `faulty(check)` switches on one bug per standard check, for
 * the broken agent; the reference agent has none.
 */
import { streamText } from "ai";
import { verifyKey } from "discord-interactions";
import {
  type APIInteraction,
  type APIInteractionResponse,
  Client,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
  InteractionResponseType,
  InteractionType,
  type Message,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  Routes,
  SimpleShardingStrategy,
} from "discord.js";

import { answer, wantsWriting, writer } from "./scripted-model.ts";
import { serve } from "./serve.ts";

/** Discord's limit for a message's text. */
const MAX_CONTENT = 2000;
/** What makes the agent ask for an approval: "deploy web to production". */
const DEPLOY = /deploy (\S+)(?: to (\S+))?/i;

/** Split a long answer into messages under Discord's limit, at line breaks where it can. */
function chunks(text: string, size = MAX_CONTENT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size) > size / 2 ? rest.lastIndexOf("\n", size) : size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim() !== "") parts.push(rest);
  return parts;
}

const approveButtons = (service: string, environment: string) => [
  {
    type: 1,
    components: [
      { type: 2, style: 3, label: "Approve", custom_id: `deploy:approve:${service}:${environment}` },
      { type: 2, style: 4, label: "Cancel", custom_id: `deploy:cancel:${service}:${environment}` },
    ],
  },
];

export interface DiscordAgentOptions {
  token: string;
  apiUrl: string | undefined;
  applicationId: string;
  publicKey: string;
  guildId: string;
  port: number;
  /**
   * Bots that are people to this agent: the ones a live run's people write as (Discord has no API
   * that acts as a person, so a live person is a second bot). Empty in the fake, where people are people.
   */
  people?: readonly string[] | undefined;
  /** One bug per standard check, for the broken agent. */
  faulty?: (check: string) => boolean;
}

/** Start the agent: log in, register its commands, then take interactions on `port`. */
export async function startDiscordAgent(options: DiscordAgentOptions): Promise<void> {
  const faulty = options.faulty ?? (() => false);
  const people = new Set(options.people ?? []);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ],
    // DMs, and reactions on messages from before the bot started, arrive for what it hasn't cached.
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    ...(options.apiUrl ? { rest: { api: options.apiUrl } } : {}),
    // Bug: forgets its Gateway session, so after a drop it identifies anew instead of resuming.
    ...(faulty("discord.resume")
      ? {
          ws: {
            buildStrategy: (manager: ConstructorParameters<typeof SimpleShardingStrategy>[0]) => {
              manager.options.retrieveSessionInfo = () => null;
              return new SimpleShardingStrategy(manager);
            },
          },
        }
      : {}),
  });
  const answered = new Set<string>();
  const approved = new Set<string>();
  let tickets = 100;

  /** Answer a message: in the thread it was asked in, or as Discord's reply to it. */
  const respond = async (message: Message, prompt: string) => {
    const deploy = DEPLOY.exec(prompt);
    if (deploy) {
      const [, service = "web", environment = "staging"] = deploy;
      await message.reply({
        content: `Deploy ${service} to ${environment}? An admin needs to approve.`,
        components: approveButtons(service, environment) as never,
      });
      return;
    }
    if (wantsWriting(prompt)) {
      const result = streamText({ model: writer(prompt), prompt });
      const text = await result.text;
      // A long answer goes into a thread of its own, in messages under Discord's limit.
      const where = message.guild ? await message.startThread({ name: prompt.slice(0, 90) }) : message.channel;
      // Bug: sends it in one message, which Discord refuses past 2000 characters.
      const parts = faulty("discord.long-answer") ? [text] : chunks(text);
      for (const part of parts) if ("send" in where) await where.send(part);
      return;
    }
    const reply = answer(prompt, message.author.id);
    await message.reply(reply);
    // Bug: answers a mention twice.
    if (faulty("discord.mention-once") && message.guild) await message.reply(reply);
  };

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.id === client.user?.id) return;
    // Bug: answers other bots too.
    if (message.author.bot && !people.has(message.author.id) && !faulty("discord.ignores-bots")) return;
    if (answered.has(message.id)) return;
    const me = client.user?.id ?? "";
    const inDm = message.guild === null;
    // Bug: doesn't answer DMs.
    if (inDm && faulty("discord.dm-once")) return;
    const mentioned = message.mentions.users.has(me);
    const toMe = message.reference?.messageId
      ? (await message.fetchReference().catch(() => undefined))?.author.id === me
      : false;
    const inMyThread = message.channel.isThread() && message.channel.ownerId === me;
    if (!inDm && !mentioned && !toMe && !inMyThread) return;
    answered.add(message.id);
    const prompt = message.content.replace(/<@!?\d+>/g, "").trim();
    if (mentioned && !inDm) await message.react("👀");
    await respond(message, prompt);
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if ((user.bot && !people.has(user.id)) || reaction.emoji.name !== "🎫") return;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    tickets += 1;
    await message.reply(`Filed ENG-${tickets} for this.`);
  });

  /** The response to an interaction: the same over HTTP and over the Gateway. */
  const interaction = async (body: APIInteraction): Promise<APIInteractionResponse | undefined> => {
    // Bug: answers after Discord's 3 seconds.
    if (faulty("discord.interaction-3s")) await new Promise((resolve) => setTimeout(resolve, 3500));
    if (body.type === InteractionType.Ping) return { type: InteractionResponseType.Pong };
    if (body.type === InteractionType.ApplicationCommand) {
      const data = body.data as { name: string; options?: Array<{ name: string; value: unknown }> };
      const option = (name: string) => data.options?.find((each) => each.name === name)?.value;
      if (data.name === "deploy") {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: `Deploying ${String(option("service"))} to ${String(option("environment") ?? "staging")}.` },
        };
      }
      if (data.name === "report") {
        // Deferred: "my-agent is thinking…", then the original is edited once the report is ready.
        setTimeout(() => {
          void client.rest.patch(Routes.webhookMessage(options.applicationId, body.token, "@original"), {
            body: { content: "The weekly report is ready: 12 incidents, 3 still open." },
          });
        }, 500);
        return { type: InteractionResponseType.DeferredChannelMessageWithSource };
      }
      return undefined;
    }
    if (body.type === InteractionType.MessageComponent) {
      const [, action, service, environment] = (body.data as { custom_id: string }).custom_id.split(":");
      const member = body.member;
      const admin = member ? (BigInt(member.permissions) & PermissionFlagsBits.Administrator) !== 0n : false;
      const key = `${body.message.id}`;
      if (action === "cancel") {
        return { type: InteractionResponseType.UpdateMessage, data: { content: "Cancelled.", components: [] } };
      }
      if (!admin) {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: "Only admins can approve a deploy.", flags: MessageFlags.Ephemeral },
        };
      }
      if (approved.has(key)) {
        return {
          type: InteractionResponseType.ChannelMessageWithSource,
          data: { content: "That was approved already.", flags: MessageFlags.Ephemeral },
        };
      }
      approved.add(key);
      return {
        type: InteractionResponseType.UpdateMessage,
        data: { content: `Deploying ${service} to ${environment}, approved by <@${member?.user.id}>.`, components: [] },
      };
    }
    return undefined;
  };

  // Without an interactions endpoint, Discord sends interactions over the Gateway; the answer is a callback.
  client.ws.on(GatewayDispatchEvents.InteractionCreate, async (body: APIInteraction) => {
    const response = await interaction(body);
    if (response)
      await client.rest.post(Routes.interactionCallback(body.id, body.token), { body: response, auth: false });
  });

  client.once(Events.ClientReady, async () => {
    await client.rest.put(Routes.applicationGuildCommands(options.applicationId, options.guildId), {
      body: [
        {
          name: "deploy",
          description: "Deploy a service",
          options: [
            { type: 3, name: "service", description: "What to deploy", required: true },
            { type: 3, name: "environment", description: "Where to" },
          ],
        },
        { name: "report", description: "The weekly incident report" },
      ],
    });
    // Ready: the agent takes interactions over HTTP from now on.
    serve(options.port, "/interactions", async (request, body) => {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const signature = request.headers.get("x-signature-ed25519") ?? "";
      const timestamp = request.headers.get("x-signature-timestamp") ?? "";
      // Bug: takes any interaction, signed or not.
      const valid = faulty("discord.bad-signature") || (await verifyKey(body, signature, timestamp, options.publicKey));
      if (!valid) return new Response("invalid request signature", { status: 401 });
      const response = await interaction(JSON.parse(body) as APIInteraction);
      return response ? Response.json(response) : new Response("unknown interaction", { status: 400 });
    });
  });

  await client.login(options.token);
}
