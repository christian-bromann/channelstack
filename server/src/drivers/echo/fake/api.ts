import type { Hono } from "hono";
import { z } from "zod";

import { bearerFrom } from "../../../core/auth/index.ts";
import { type RestAnswer, restApi } from "../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import type { EchoApp, EchoRoom } from "../world.ts";
import type { EchoStore } from "./store.ts";
import type { FakeEchoWorld } from "./world.ts";

const PostMessage = z.object({ room: z.string(), text: z.string().min(1) });

interface Outcome {
  status: 200 | 400 | 401 | 403 | 404;
  body: { ok: true; [key: string]: unknown } | { ok: false; error: string };
  /** The room the call was about, when there is one: its owner's session gets the call in its event log. */
  room?: string;
}

const ROOM_NOT_FOUND: Outcome = { status: 404, body: { ok: false, error: "room_not_found" } };

/**
 * The echo platform's provider API, as the agent sees it:
 *
 *   POST /api/messages                 { room, text }   post as the app
 *   GET  /api/rooms/{room}/messages                     read a room the app is in
 *
 * It authenticates the app's token and refuses what the platform refuses (`invalid_auth`,
 * `room_not_found`, `not_in_room`). Every call about a room is recorded for the session that owns it.
 */
export function createEchoApi(context: DriverContext, store: EchoStore, world: FakeEchoWorld): Hono {
  /** The app whose token a request carries: each app's token answers as that app (decision 0027). */
  const callerOf = (authorization: string | undefined): EchoApp | undefined => {
    const token = bearerFrom(authorization);
    return token === undefined
      ? undefined
      : store.apps.all().find((app) => constantTimeEqual(token, context.apps.secret(store.keyOf(app), "appToken")));
  };
  /** What the platform refuses: a room that doesn't exist, or one the app isn't a member of. */
  const refusal = (room: EchoRoom | undefined, id: string, app: EchoApp): Outcome | undefined => {
    if (!room) return ROOM_NOT_FOUND;
    if (!room.members.includes(app.id)) return { status: 403, body: { ok: false, error: "not_in_room" }, room: id };
    return undefined;
  };
  /** An outcome as the endpoint answers it: on record for the session that owns its room. */
  const answer = (outcome: Outcome): RestAnswer => ({
    body: outcome.body,
    status: outcome.status,
    sessions: [outcome.room === undefined ? undefined : store.rooms.owner(outcome.room)],
  });

  const { endpoint, finish } = restApi(context, {
    driver: "echo",
    // A call about no room is the app's own business: it is on no session's record.
    unattributed: "drop",
    authorize(c) {
      if (callerOf(c.req.header("authorization")) !== undefined) return undefined;
      return answer({ status: 401, body: { ok: false, error: "invalid_auth" } });
    },
    refusal: () => undefined,
    invalidJson: () => answer({ status: 400, body: { ok: false, error: "invalid_payload" } }),
    notFound: () => answer({ status: 404, body: { ok: false, error: "unknown_method" } }),
  });

  endpoint("post", "/api/messages", "messages.create", (c, request) => {
    const app = callerOf(c.req.header("authorization")) ?? store.app;
    const parsed = PostMessage.safeParse(request);
    if (!parsed.success) return answer({ status: 400, body: { ok: false, error: "invalid_payload" } });
    const room = store.rooms.find(parsed.data.room);
    const refused = refusal(room, parsed.data.room, app);
    if (refused || !room) return answer(refused ?? ROOM_NOT_FOUND);
    return answer({
      status: 200,
      body: { ok: true, message: world.postAsApp(room, parsed.data.text, app) },
      room: room.id,
    });
  });

  endpoint("get", "/api/rooms/:room/messages", "rooms.messages", (c) => {
    const app = callerOf(c.req.header("authorization")) ?? store.app;
    const id = c.req.param("room") ?? "";
    const refused = refusal(store.rooms.find(id), id, app);
    if (refused) return answer(refused);
    return answer({ status: 200, body: { ok: true, messages: store.messagesIn(id).read().items }, room: id });
  });

  return finish();
}
