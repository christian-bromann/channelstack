import type { DeliveryKit } from "../../../core/delivery/kit.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { commandValues, typedCommand } from "../commands.ts";
import { discordSnowflake } from "../ids.ts";
import { type Author, JOINED_AT, memberObject, MESSAGE_FLAGS } from "../payloads.ts";
import { has } from "../permissions.ts";
import { DISCORD_SECRETS } from "../secrets.ts";
import {
  type DiscordAppRecord,
  type DiscordButtonRef,
  type DiscordChannelRecord,
  type DiscordGuildRecord,
  type DiscordMessageRecord,
  DiscordRefusal,
  INTERACTION_WINDOW_MS,
} from "../world.ts";
import type { Intent } from "./gateway.ts";
import type { DiscordCommandRecord, DiscordInteractionRecord, DiscordStore } from "./store.ts";

/** An interaction's token works for followups and its original for 15 minutes. */
const TOKEN_LIFETIME_MS = 15 * 60_000;

/** Discord's interaction types, and its response types. */
const INTERACTION = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 } as const;
const RESPONSE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;
/** Discord's option types the fake fills from a command's text. */
const OPTION = { STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, NUMBER: 10 } as const;

/** What a person sees when the app doesn't answer an interaction in time. */
const INTERACTION_FAILED = "This interaction failed";

/** What the interactions need from the rest of the fake world. */
export interface InteractionDeps {
  store: DiscordStore;
  kit: DeliveryKit;
  dispatchTo(
    app: DiscordAppRecord,
    session: string | undefined,
    type: string,
    payload: unknown,
    intent: Intent | undefined,
  ): string | undefined;
  /** The built-in app. */
  app(): DiscordAppRecord;
  guild(): DiscordGuildRecord;
  authorOf(id: string): Author | undefined;
  userWire(id: string): Record<string, unknown>;
  channelWire(channel: DiscordChannelRecord, reader?: DiscordAppRecord): Record<string, unknown>;
  messageWire(message: DiscordMessageRecord, reader?: DiscordAppRecord): Record<string, unknown>;
  permissionsOf(id: string, channel: DiscordChannelRecord): bigint;
  rolesOf(id: string): string[];
  checkContent(input: MessageFields, within?: "data"): void;
  postAsBot(
    channel: DiscordChannelRecord,
    input: { content: string; embeds: unknown[]; components: unknown[] },
    options?: {
      replyTo?: string | undefined;
      type?: number;
      flags?: number;
      ephemeralFor?: string | undefined;
      interaction?: DiscordMessageRecord["interaction"];
    },
    app?: DiscordAppRecord,
  ): DiscordMessageRecord;
  newMessage(
    channel: DiscordChannelRecord,
    authorId: string,
    input: { content: string; embeds: unknown[]; components: unknown[] },
    options?: {
      type?: number;
      flags?: number;
      ephemeralFor?: string | undefined;
      interaction?: DiscordMessageRecord["interaction"];
      system?: boolean;
    },
  ): DiscordMessageRecord;
  update(
    message: DiscordMessageRecord,
    changes: { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number },
  ): DiscordMessageRecord;
}

/** The fields of a message the app writes: what an interaction response, a followup or an edit carries. */
interface MessageFields {
  content?: unknown;
  embeds?: unknown;
  components?: unknown;
  flags?: unknown;
}

export interface Interactions {
  /**
   * A person runs one of an app's slash commands: the named app's, or the built-in app's when it
   * has one of that name, or another app's (decision 0027). Returns the delivery.
   */
  command(
    session: string,
    user: string,
    text: string,
    channel: DiscordChannelRecord,
    app?: DiscordAppRecord,
  ): Promise<string | undefined>;
  /** A person presses a button on a message: the interaction goes to the app whose message it is. Returns the delivery. */
  click(session: string, user: string, button: DiscordButtonRef, message: DiscordMessageRecord): string | undefined;
  /** An app's newest message in a channel that has this button. */
  latestWith(user: string, channel: DiscordChannelRecord, button: DiscordButtonRef): DiscordMessageRecord;
  /** Discord's check of a new interactions endpoint: a PING answered with a PONG, and a forged one refused. */
  verifyEndpoint(session: string): Promise<{ valid: boolean; problems: string[]; deliveries: string[] }>;
  /** `POST /interactions/{id}/{token}/callback`: the app's response. */
  callback(id: string, token: string, body: Record<string, unknown>): { message: DiscordMessageRecord | undefined };
  /** The interaction a token belongs to, for its app's followups: refused when it is unknown, another app's or expired. */
  byToken(applicationId: string, token: string): DiscordInteractionRecord;
  /** `@original`: the message the response made, or the component's message. */
  original(interaction: DiscordInteractionRecord): DiscordMessageRecord;
  /** A followup message. */
  followup(interaction: DiscordInteractionRecord, body: MessageFields): DiscordMessageRecord;
  /** Edit the original or a followup. */
  editResponse(
    interaction: DiscordInteractionRecord,
    message: DiscordMessageRecord,
    body: MessageFields,
  ): DiscordMessageRecord;
  commandWire(command: DiscordCommandRecord): Record<string, unknown>;
  /** Register an app's commands: one (`POST`), or every one, replacing what it had there (`PUT`). */
  saveCommands(
    app: DiscordAppRecord,
    guildId: string | undefined,
    commands: readonly Record<string, unknown>[],
    replace: boolean,
  ): DiscordCommandRecord[];
  commands(app: DiscordAppRecord, guildId: string | undefined): DiscordCommandRecord[];
  /** What the app left open: a deferred response it hasn't finished. */
  openWork(session: string): string[];
}

const contentOf = (fields: MessageFields) => ({
  content: typeof fields.content === "string" ? fields.content : "",
  embeds: Array.isArray(fields.embeds) ? fields.embeds : [],
  components: Array.isArray(fields.components) ? fields.components : [],
});

/** Every button in a message's components, in the order a person sees them. */
function buttonsOf(components: readonly unknown[]): Array<Record<string, unknown>> {
  return components.flatMap((row) => {
    const children = (row as { components?: unknown }).components;
    return Array.isArray(children)
      ? children.filter((child): child is Record<string, unknown> => (child as { type?: unknown }).type === 2)
      : [];
  });
}

export function createInteractions(context: DriverContext, deps: InteractionDeps): Interactions {
  const { clock, timers } = context;
  const { store } = deps;
  /** The app an interaction or a command is for. */
  const appNamed = (name: string): DiscordAppRecord => store.apps.named(name) ?? deps.app();

  const memberWire = (user: string, channel: DiscordChannelRecord) => ({
    ...memberObject(deps.rolesOf(user), JOINED_AT),
    user: deps.userWire(user),
    permissions: deps.permissionsOf(user, channel).toString(),
  });

  /** What every interaction carries: who, where, its token. */
  const envelope = (record: DiscordInteractionRecord, channel: DiscordChannelRecord) => {
    const inGuild = channel.kind !== "dm";
    const app = appNamed(record.app);
    return {
      app_permissions: deps.permissionsOf(app.botUserId, channel).toString(),
      application_id: app.id,
      attachment_size_limit: 10_485_760,
      authorizing_integration_owners: { 0: deps.guild().id },
      channel: deps.channelWire(channel, app),
      channel_id: channel.id,
      context: inGuild ? 0 : 1,
      entitlement_sku_ids: [],
      entitlements: [],
      id: record.id,
      locale: "en-US",
      token: record.token,
      type: record.type,
      version: 1,
      ...(inGuild
        ? {
            guild: { id: deps.guild().id, locale: "en-US", features: [] },
            guild_id: deps.guild().id,
            guild_locale: "en-US",
            member: memberWire(record.userId, channel),
          }
        : { user: deps.userWire(record.userId) }),
    };
  };

  /** A person saw "This interaction failed": the app didn't answer within 3 seconds. */
  const fail = (record: DiscordInteractionRecord) => {
    if (record.state !== "pending") return;
    record.state = "failed";
    const channel = store.channels.find(record.channelId);
    if (!channel) return;
    deps.newMessage(
      channel,
      appNamed(record.app).botUserId,
      { content: INTERACTION_FAILED, embeds: [], components: [] },
      { flags: MESSAGE_FLAGS.EPHEMERAL, ephemeralFor: record.userId, system: true },
    );
  };

  const messageOf = (record: DiscordInteractionRecord, id: string | undefined) => {
    const message = id === undefined ? undefined : store.findMessage(record.channelId, id);
    if (!message) throw new DiscordRefusal(10008);
    return message;
  };

  /** The app's response to an interaction, over HTTP or its callback. */
  const respond = (
    record: DiscordInteractionRecord,
    body: Record<string, unknown>,
  ): DiscordMessageRecord | undefined => {
    const type = body.type;
    const data = (typeof body.data === "object" && body.data !== null ? body.data : {}) as MessageFields;
    const channel = store.channels.find(record.channelId);
    const flags = typeof data.flags === "number" ? data.flags : 0;
    const ephemeral = (flags & MESSAGE_FLAGS.EPHEMERAL) !== 0;
    const metadata = {
      id: record.id,
      type: record.type,
      name: record.name,
      userId: record.userId,
      messageId: record.messageId,
    };
    const invalid = (message: string) =>
      new DiscordRefusal(50035, { errors: { type: { _errors: [{ code: "BASE_TYPE_CHOICES", message }] } } });
    if (record.type === INTERACTION.PING) {
      if (type !== RESPONSE.PONG) throw invalid("A PING is answered with a PONG.");
      record.state = "responded";
      return undefined;
    }
    if (!channel) throw new DiscordRefusal(10003);
    const app = appNamed(record.app);
    let message: DiscordMessageRecord | undefined;
    switch (type) {
      case RESPONSE.CHANNEL_MESSAGE_WITH_SOURCE: {
        const fields = contentOf(data);
        deps.checkContent(fields, "data");
        message = deps.postAsBot(
          channel,
          fields,
          {
            type: record.type === INTERACTION.APPLICATION_COMMAND ? 20 : 0,
            flags: ephemeral ? MESSAGE_FLAGS.EPHEMERAL : 0,
            ephemeralFor: ephemeral ? record.userId : undefined,
            interaction: metadata,
          },
          app,
        );
        record.original = message.id;
        break;
      }
      case RESPONSE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE:
        // "my-agent is thinking…" until the app edits its original.
        message = deps.postAsBot(
          channel,
          { content: "", embeds: [], components: [] },
          {
            type: record.type === INTERACTION.APPLICATION_COMMAND ? 20 : 0,
            flags: MESSAGE_FLAGS.LOADING | (ephemeral ? MESSAGE_FLAGS.EPHEMERAL : 0),
            ephemeralFor: ephemeral ? record.userId : undefined,
            interaction: metadata,
          },
          app,
        );
        record.original = message.id;
        break;
      case RESPONSE.DEFERRED_UPDATE_MESSAGE:
        if (record.type !== INTERACTION.MESSAGE_COMPONENT)
          throw invalid("Only a component's interaction updates its message.");
        record.original = record.messageId;
        break;
      case RESPONSE.UPDATE_MESSAGE: {
        if (record.type !== INTERACTION.MESSAGE_COMPONENT)
          throw invalid("Only a component's interaction updates its message.");
        const target = messageOf(record, record.messageId);
        message = edit(target, data, "data");
        record.original = target.id;
        break;
      }
      case RESPONSE.MODAL:
        // A modal opens for the person; filling one in isn't in the fake yet.
        break;
      default:
        throw invalid("Value must be one of {1, 4, 5, 6, 7, 8, 9, 10, 12}.");
    }
    record.state = "responded";
    return message;
  };

  /** Change a message the app answers with: what the body has, and no longer loading. */
  const edit = (message: DiscordMessageRecord, fields: MessageFields, within?: "data") => {
    const next = {
      content: typeof fields.content === "string" ? fields.content : message.content,
      embeds: Array.isArray(fields.embeds) ? fields.embeds : message.embeds,
      components: Array.isArray(fields.components) ? fields.components : message.components,
    };
    deps.checkContent(next, within);
    return deps.update(message, { ...next, flags: message.flags & ~MESSAGE_FLAGS.LOADING });
  };

  /**
   * Hand an interaction to the one app it belongs to: its endpoint over HTTP when it has one, its
   * Gateway connection otherwise. Signed with that app's own key.
   */
  const deliver = (record: DiscordInteractionRecord, payload: Record<string, unknown>, eventType: string) => {
    timers.after(INTERACTION_WINDOW_MS, () => fail(record));
    const app = appNamed(record.app);
    const webhookUrl = context.apps.webhookUrl(app.name);
    if (webhookUrl === undefined) {
      record.delivery = deps.dispatchTo(app, record.session, "INTERACTION_CREATE", payload, undefined);
      return record.delivery;
    }
    deps.kit.send({
      id: record.id,
      session: record.session,
      app: app.name,
      type: eventType,
      url: webhookUrl,
      body: JSON.stringify(payload),
      retry: false,
      meta: { payload },
      answered: (answer) => {
        let body: unknown;
        try {
          body = JSON.parse(answer.body);
        } catch {
          throw new Error("The interaction's response isn't JSON");
        }
        if (typeof body !== "object" || body === null) throw new Error("The interaction's response isn't an object");
        if (record.state !== "pending") return;
        respond(record, body as Record<string, unknown>);
      },
    });
    record.delivery = record.id;
    return record.id;
  };

  const start = (
    session: string,
    type: number,
    user: string,
    channel: DiscordChannelRecord,
    extra: { messageId?: string | undefined; name?: string | undefined },
    app: DiscordAppRecord,
  ): DiscordInteractionRecord => {
    const record: DiscordInteractionRecord = {
      id: discordSnowflake(context.ids),
      app: app.name,
      token: DISCORD_SECRETS.interactionToken.generate(),
      session,
      type,
      userId: user,
      channelId: channel.id,
      messageId: extra.messageId,
      name: extra.name,
      createdAt: clock(),
      delivery: undefined,
      state: "pending",
      original: undefined,
    };
    store.interactions.set(record.id, record);
    return record;
  };

  /**
   * The command of that name a person picks: the named app's, or else the built-in app's, then
   * the others' in the order they were made. A guild's command before a global one of an app.
   */
  const findCommand = (name: string, only: DiscordAppRecord | undefined) => {
    const all = [...store.commands.values()];
    for (const app of only ? [only] : store.apps.all()) {
      const found =
        all.find(
          (command) => command.app === app.name && command.name === name && command.guildId === deps.guild().id,
        ) ?? all.find((command) => command.app === app.name && command.name === name && command.guildId === undefined);
      if (found) return found;
    }
    return undefined;
  };

  /** A command's options from what a person typed after it: `name:value`, or in the order the command lists them. */
  /**
   * A command's options as Discord sends them, with what they name in `resolved`: the user (and,
   * in a guild, the member) of a USER option, the channel of a CHANNEL option. One that names
   * nobody is refused: Discord's client offers only real ones.
   */
  const optionsOf = (
    command: DiscordCommandRecord,
    words: string[],
    session: string,
    channel: DiscordChannelRecord,
  ) => {
    const resolved = {
      users: {} as Record<string, unknown>,
      members: {} as Record<string, unknown>,
      channels: {} as Record<string, unknown>,
    };
    const refuse = (name: string, text: string) =>
      new ProtocolError("invalid_argument", `/${command.name}'s option "${name}" names nobody here: "${text}"`, {
        option: name,
      });
    const options = commandValues(command, words).map(({ option, text }) => {
      if (option.type === OPTION.USER) {
        const wanted = text.replace(/^@/, "").toLowerCase();
        const found =
          store.apps.namedIn(session, wanted)?.botUserId ??
          store
            .usersOf(session)
            .find((user) => user.name.toLowerCase() === wanted || user.username === wanted || user.id === text)?.id;
        if (found === undefined) throw refuse(option.name, text);
        resolved.users[found] = deps.userWire(found);
        if (channel.kind !== "dm") {
          const { user: _user, ...member } = memberWire(found, channel);
          resolved.members[found] = member;
        }
        return { name: option.name, type: option.type, value: found };
      }
      if (option.type === OPTION.CHANNEL) {
        const named = text.replace(/^#/, "");
        const found = store.channelsOf(session).find((each) => each.id === named || each.name === named);
        if (!found) throw refuse(option.name, text);
        resolved.channels[found.id] = deps.channelWire(found);
        return { name: option.name, type: option.type, value: found.id };
      }
      const value =
        option.type === OPTION.INTEGER || option.type === OPTION.NUMBER
          ? Number(text)
          : option.type === OPTION.BOOLEAN
            ? text === "true"
            : text;
      return { name: option.name, type: option.type, value };
    });
    const any = Object.values(resolved).some((part) => Object.keys(part).length > 0);
    return {
      options,
      resolved: any
        ? Object.fromEntries(Object.entries(resolved).filter(([, part]) => Object.keys(part).length > 0))
        : undefined,
    };
  };

  const commandWire = (command: DiscordCommandRecord): Record<string, unknown> => ({
    id: command.id,
    type: command.type,
    application_id: appNamed(command.app).id,
    ...(command.guildId === undefined ? {} : { guild_id: command.guildId }),
    name: command.name,
    name_localizations: null,
    description: command.description,
    description_localizations: null,
    ...(command.options.length === 0 ? {} : { options: command.options }),
    default_member_permissions: null,
    dm_permission: true,
    contexts: null,
    integration_types: [0],
    nsfw: false,
    version: command.version,
  });

  return {
    async command(session, user, text, channel, only) {
      const { command, words } = await typedCommand(text, (name) => findCommand(name, only));
      const name = command.name;
      if (!has(deps.permissionsOf(user, channel), "USE_APPLICATION_COMMANDS")) throw new DiscordRefusal(50013);
      const { options, resolved } = optionsOf(command, words, session, channel);
      const record = start(session, INTERACTION.APPLICATION_COMMAND, user, channel, { name }, appNamed(command.app));
      const payload = {
        ...envelope(record, channel),
        data: {
          id: command.id,
          name: command.name,
          type: 1,
          ...(command.guildId === undefined ? {} : { guild_id: command.guildId }),
          ...(options.length === 0 ? {} : { options }),
          ...(resolved ? { resolved } : {}),
        },
      };
      return deliver(record, payload, "INTERACTION_CREATE");
    },

    click(session, user, button, message) {
      const found = buttonsOf(message.components).find(
        (candidate) =>
          (button.customId !== undefined && candidate.custom_id === button.customId) ||
          (button.label !== undefined && candidate.label === button.label),
      );
      if (!found || found.disabled === true) {
        throw new ProtocolError(
          "not_found",
          `No button ${JSON.stringify(button.label ?? button.customId)} to press on message ${message.id}`,
          {
            message: message.id,
          },
        );
      }
      if (typeof found.custom_id !== "string") {
        throw new ProtocolError("invalid_argument", "A link button opens its URL: there is no interaction");
      }
      const channel = store.channels.find(message.channelId);
      if (!channel) throw new DiscordRefusal(10003);
      // A button is on one app's message, and its interaction goes to that app alone (decision 0027).
      const app = store.appOf(message.authorId) ?? deps.app();
      const record = start(session, INTERACTION.MESSAGE_COMPONENT, user, channel, { messageId: message.id }, app);
      const payload = {
        ...envelope(record, channel),
        data: { custom_id: found.custom_id, component_type: 2 },
        message: deps.messageWire(message, app),
      };
      return deliver(record, payload, "INTERACTION_CREATE");
    },

    latestWith(user, channel, button) {
      const found = store
        .messagesIn(channel.id)
        .filter(
          (message) =>
            store.appOf(message.authorId) !== undefined &&
            (message.ephemeralFor === undefined || message.ephemeralFor === user),
        )
        .reverse()
        .find((message) =>
          buttonsOf(message.components).some(
            (candidate) =>
              candidate.label === button.label ||
              (button.customId !== undefined && candidate.custom_id === button.customId),
          ),
        );
      if (!found) {
        throw new ProtocolError(
          "not_found",
          `No message from the app in ${channel.id} has the button ${JSON.stringify(button.label ?? button.customId)}`,
          {
            channel: channel.id,
          },
        );
      }
      return found;
    },

    async verifyEndpoint(session) {
      const webhookUrl = context.apps.webhookUrl(deps.app().name);
      if (webhookUrl === undefined) {
        return {
          valid: false,
          problems: ["The app has no interactions endpoint (CHANNELSTACK_DISCORD_WEBHOOK_URL)"],
          deliveries: [],
        };
      }
      const channel = store.channelsOf(session)[0];
      const record: DiscordInteractionRecord = {
        id: discordSnowflake(context.ids),
        app: deps.app().name,
        token: DISCORD_SECRETS.interactionToken.generate(),
        session,
        type: INTERACTION.PING,
        userId: "",
        channelId: channel?.id ?? "",
        messageId: undefined,
        name: undefined,
        createdAt: clock(),
        delivery: undefined,
        state: "pending",
        original: undefined,
      };
      store.interactions.set(record.id, record);
      const payload = {
        application_id: deps.app().id,
        entitlements: [],
        id: record.id,
        token: record.token,
        type: INTERACTION.PING,
        user: {
          id: deps.app().botUserId,
          username: "discord",
          discriminator: "0000",
          avatar: null,
          global_name: "Discord",
        },
        version: 1,
      };
      let pong = false;
      const sent = deps.kit.send({
        id: record.id,
        session,
        type: "PING",
        url: webhookUrl,
        body: JSON.stringify(payload),
        retry: false,
        meta: { payload },
        answered: (answer) => {
          try {
            pong = (JSON.parse(answer.body) as { type?: unknown }).type === RESPONSE.PONG;
          } catch {
            pong = false;
          }
        },
      });
      await sent.sent;
      const first = sent.attempts[0];
      const forged = await deps.kit.resend(session, record.id, { badSignature: true });
      const problems = [
        ...(first?.status === "acknowledged"
          ? []
          : [`The PING got ${first?.responseStatus ?? first?.status}, not 200 with a PONG`]),
        ...(first?.status === "acknowledged" && !pong ? ['The PING was answered, but not with { "type": 1 }'] : []),
        ...(forged.responseStatus === 401
          ? []
          : [`A PING with a bad signature got ${forged.responseStatus ?? forged.status}, not 401`]),
      ];
      return { valid: problems.length === 0, problems, deliveries: [record.id] };
    },

    callback(id, token, body) {
      const record = store.interactions.get(id);
      if (!record || !constantTimeEqual(record.token, token)) throw new DiscordRefusal(10062);
      if (record.state === "pending" && clock() - record.createdAt > INTERACTION_WINDOW_MS) fail(record);
      if (record.state === "failed") throw new DiscordRefusal(10062);
      if (record.state === "responded") throw new DiscordRefusal(40060);
      return { message: respond(record, body) };
    },

    byToken(applicationId, token) {
      // An interaction's token is its app's: another application's id in the path finds nothing.
      const found = [...store.interactions.values()].find(
        (record) => constantTimeEqual(record.token, token) && appNamed(record.app).id === applicationId,
      );
      if (!found || clock() - found.createdAt > TOKEN_LIFETIME_MS || found.state !== "responded") {
        throw new DiscordRefusal(10015);
      }
      return found;
    },

    original: (record) => messageOf(record, record.original),

    followup(record, body) {
      const channel = store.channels.find(record.channelId);
      if (!channel) throw new DiscordRefusal(10003);
      const fields = contentOf(body);
      deps.checkContent(fields);
      const flags = typeof body.flags === "number" ? body.flags : 0;
      const ephemeral = (flags & MESSAGE_FLAGS.EPHEMERAL) !== 0;
      return deps.postAsBot(
        channel,
        fields,
        {
          flags: ephemeral ? MESSAGE_FLAGS.EPHEMERAL : 0,
          ephemeralFor: ephemeral ? record.userId : undefined,
          interaction: {
            id: record.id,
            type: record.type,
            name: record.name,
            userId: record.userId,
            messageId: record.messageId,
          },
        },
        appNamed(record.app),
      );
    },

    editResponse: (_record, message, body) => edit(message, body),

    commandWire,

    saveCommands(app, guildId, list, replace) {
      const saved = list.map((raw) => {
        const name = typeof raw.name === "string" ? raw.name : "";
        if (!/^[-_\p{L}\p{N}]{1,32}$/u.test(name) || name !== name.toLowerCase()) {
          throw new DiscordRefusal(50035, {
            errors: {
              name: { _errors: [{ code: "APPLICATION_COMMAND_INVALID_NAME", message: "Command name is invalid" }] },
            },
          });
        }
        const existing = [...store.commands.values()].find(
          (command) => command.app === app.name && command.name === name && command.guildId === guildId,
        );
        const record: DiscordCommandRecord = {
          id: existing?.id ?? discordSnowflake(context.ids),
          app: app.name,
          name,
          description: typeof raw.description === "string" ? raw.description : "",
          type: typeof raw.type === "number" ? raw.type : 1,
          options: Array.isArray(raw.options) ? (raw.options as DiscordCommandRecord["options"]) : [],
          guildId,
          version: discordSnowflake(context.ids),
        };
        return record;
      });
      if (replace)
        for (const [id, command] of store.commands)
          if (command.app === app.name && command.guildId === guildId) store.commands.delete(id);
      for (const record of saved) store.commands.set(record.id, record);
      return saved;
    },

    commands: (app, guildId) =>
      [...store.commands.values()].filter((command) => command.app === app.name && command.guildId === guildId),

    openWork(session) {
      return [...store.interactions.values()].flatMap((record) => {
        if (record.session !== session || record.original === undefined) return [];
        const message = store.findMessage(record.channelId, record.original);
        if (!message || (message.flags & MESSAGE_FLAGS.LOADING) === 0) return [];
        const what = record.name ? `/${record.name}` : "a button";
        const app = appNamed(record.app).name;
        return [`a deferred response to ${what} ${app} never finished (still "${app} is thinking…")`];
      });
    },
  };
}
