import { BUILT_IN_APP } from "../../../core/apps/index.ts";
import { deliveryKit } from "../../../core/delivery/kit.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { ECHO_IDS } from "../ids.ts";
import { messageCreated } from "../payloads.ts";
import { signEchoDelivery } from "../signing.ts";
import type { EchoApp, EchoMessage, EchoPrincipal, EchoRoom, EchoWorld } from "../world.ts";
import type { EchoStore } from "./store.ts";

/** The echo platform acks within 3 seconds, like Slack. */
const ACK_WINDOW_MS = 3000;

/** The fake `EchoWorld`, plus the one action an agent takes through the provider API, as its app. */
export interface FakeEchoWorld extends EchoWorld {
  postAsApp(room: EchoRoom, text: string, app?: EchoApp): EchoMessage;
}

export function createFakeWorld(context: DriverContext, store: EchoStore): FakeEchoWorld {
  const { ids, clock, events } = context;
  const deliveries = deliveryKit(context, {
    driver: "echo",
    timeoutMs: ACK_WINDOW_MS,
    sign: (secret, body, atMs) => signEchoDelivery(secret, body, atMs),
    secret: (app) => context.apps.secret(app, "signingSecret"),
  });

  /**
   * Write a message and tell every app in the room with an endpoint, but its author (decision 0027):
   * each gets its own delivery, signed with its own secret. The message's `delivery` is the built-in app's.
   */
  const post = (
    session: string | undefined,
    room: EchoRoom,
    author: EchoPrincipal,
    text: string,
    /** What the action that wrote it records, before the deliveries it causes. */
    recorded?: (message: EchoMessage) => void,
  ): EchoMessage => {
    const hearing = store.apps
      .all()
      .filter(
        (app) =>
          app.id !== author.id &&
          room.members.includes(app.id) &&
          context.apps.webhookUrl(store.apps.keyOf(app)) !== undefined,
      )
      .map((app) => ({ app, id: ids.next(ECHO_IDS.delivery) }));
    const own = hearing.find(({ app }) => store.apps.keyOf(app) === BUILT_IN_APP)?.id;
    const message: EchoMessage = {
      id: ids.next(ECHO_IDS.message),
      room: room.id,
      author,
      text,
      at: new Date(clock()).toISOString(),
      ...(own === undefined ? {} : { delivery: own }),
    };
    store.messagesIn(room.id).append(message);
    recorded?.(message);
    if (session === undefined) return message;
    // The loop guard counts what apps write where no person writes in between.
    const writer = author.kind === "app" ? { kind: "app" as const, name: author.name } : { kind: "person" as const };
    if (!context.loops.wrote(session, room.id, writer)) return message;
    for (const { app, id } of hearing) {
      const payload = messageCreated({ deliveryId: id, app, message, atMs: clock() });
      deliveries.send({
        id,
        session,
        app: store.apps.keyOf(app),
        type: payload.type,
        url: context.apps.webhookUrl(store.apps.keyOf(app)) ?? "",
        body: JSON.stringify(payload),
        meta: { payload },
      });
    }
    return message;
  };

  return {
    app: () => store.app,

    createUser(session, input) {
      store.apps.checkPerson(session, input.name);
      const id = ids.next(ECHO_IDS.user);
      const user = store.users.add(id, { id, name: input.name, kind: "user" }, session);
      events.append(session, "echo", "action", { action: "createUser", user: id });
      return user;
    },

    apps: () => store.apps.all(),

    createApp(session, input) {
      const by =
        session === undefined ? undefined : { session, people: store.users.list(session).map((user) => user.name) };
      const app = store.apps.make(
        input.name,
        {},
        () => ({ id: context.apps.ids(input.name).next(ECHO_IDS.app), name: input.name, kind: "app" }),
        by,
      );
      if (session !== undefined) events.append(session, "echo", "action", { action: "createApp", app: app.id });
      return app;
    },

    sayAsApp(session, appId, roomId, text) {
      const app = store.apps.scripted(session, appId);
      const room = store.rooms.get(session, roomId);
      if (!room.members.includes(app.id)) {
        throw new ProtocolError(
          { platform: "not_in_room", status: 403 },
          `${app.id} is not a member of room ${room.id}`,
          {
            app: app.id,
            room: room.id,
          },
        );
      }
      return post(session, room, { id: app.id, name: app.name, kind: "app" }, text, (message) =>
        events.append(session, "echo", "action", { action: "say", app: app.id, room: room.id, message: message.id }),
      );
    },

    createRoom(session, input) {
      const apps = new Set(store.apps.all().map((app) => app.id));
      for (const participant of input.participants) {
        if (!apps.has(participant)) store.users.get(session, participant);
      }
      const id = ids.next(ECHO_IDS.room);
      const room: EchoRoom = {
        id,
        name: input.name ?? `test-${id.slice(-6).toLowerCase()}`,
        members: [...new Set(input.participants)],
      };
      store.rooms.add(id, room, session);
      events.append(session, "echo", "action", { action: "createRoom", room: id });
      return room;
    },

    postAsUser(session, userId, roomId, text) {
      const user = store.users.get(session, userId);
      const room = store.rooms.get(session, roomId);
      if (!room.members.includes(user.id)) {
        throw new ProtocolError(
          { platform: "not_in_room", status: 403 },
          `${user.id} is not a member of room ${room.id}`,
          {
            user: user.id,
            room: room.id,
          },
        );
      }
      // An app only hears about rooms it is a member of, and only if it has an endpoint.
      return post(session, room, user, text, (message) =>
        events.append(session, "echo", "action", { action: "say", user: user.id, room: room.id, message: message.id }),
      );
    },

    postAsApp(room, text, app = store.app) {
      const { id, name, kind } = app;
      return post(store.rooms.owner(room.id), room, { id, name, kind }, text);
    },

    messages(session, roomId, since) {
      const room = store.rooms.get(session, roomId);
      const { items, cursor } = store.messagesIn(room.id).read(since);
      return { messages: items, cursor };
    },
  };
}
