import { deliveryKit } from "../../../core/delivery/kit.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { ECHO_IDS } from "../ids.ts";
import { messageCreated } from "../payloads.ts";
import { signEchoDelivery } from "../signing.ts";
import type { EchoMessage, EchoPrincipal, EchoRoom, EchoWorld } from "../world.ts";
import type { EchoStore } from "./store.ts";

/** The echo platform acks within 3 seconds, like Slack. */
const ACK_WINDOW_MS = 3000;

/** The fake `EchoWorld`, plus the one action the agent takes through the provider API. */
export interface FakeEchoWorld extends EchoWorld {
  postAsApp(room: EchoRoom, text: string): EchoMessage;
}

export function createFakeWorld(context: DriverContext, store: EchoStore): FakeEchoWorld {
  const { ids, clock, events } = context;
  const deliveries = deliveryKit(context, {
    driver: "echo",
    timeoutMs: ACK_WINDOW_MS,
    sign: (secret, body, atMs) => signEchoDelivery(secret, body, atMs),
    secret: () => context.secret("signingSecret"),
  });

  const post = (room: EchoRoom, author: EchoPrincipal, text: string, deliveryId?: string): EchoMessage => {
    const message: EchoMessage = {
      id: ids.next(ECHO_IDS.message),
      room: room.id,
      author,
      text,
      at: new Date(clock()).toISOString(),
      ...(deliveryId === undefined ? {} : { delivery: deliveryId }),
    };
    return store.messagesIn(room.id).append(message);
  };

  return {
    app: () => store.app,

    createUser(session, input) {
      const id = ids.next(ECHO_IDS.user);
      const user = store.users.add(id, { id, name: input.name, kind: "user" }, session);
      events.append(session, "echo", "action", { action: "createUser", user: id });
      return user;
    },

    createRoom(session, input) {
      for (const participant of input.participants) {
        if (participant !== store.app.id) store.users.get(session, participant);
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
      // The app only hears about rooms it is a member of, and only if it has an endpoint.
      const deliver = context.webhookUrl !== undefined && room.members.includes(store.app.id);
      const message = post(room, user, text, deliver ? ids.next(ECHO_IDS.delivery) : undefined);
      events.append(session, "echo", "action", { action: "say", user: user.id, room: room.id, message: message.id });
      if (context.webhookUrl !== undefined && message.delivery !== undefined) {
        const payload = messageCreated({ deliveryId: message.delivery, app: store.app, message, atMs: clock() });
        deliveries.send({
          id: message.delivery,
          session,
          type: payload.type,
          url: context.webhookUrl,
          body: JSON.stringify(payload),
          meta: { payload },
        });
      }
      return message;
    },

    postAsApp(room, text) {
      const { id, name, kind } = store.app;
      return post(room, { id, name, kind }, text);
    },

    messages(session, roomId, since) {
      const room = store.rooms.get(session, roomId);
      const { items, cursor } = store.messagesIn(room.id).read(since);
      return { messages: items, cursor };
    },
  };
}
