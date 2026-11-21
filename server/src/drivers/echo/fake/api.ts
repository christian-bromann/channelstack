import { Hono } from "hono";
import { z } from "zod";

import { bearerFrom } from "../../../core/auth/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import type { EchoRoom } from "../world.ts";
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
  const api = new Hono();

  const authorized = (header: string | undefined) => {
    const token = bearerFrom(header);
    return token !== undefined && constantTimeEqual(token, context.secret("appToken"));
  };

  /** What the platform refuses: a room that doesn't exist, or one the app isn't a member of. */
  const refusal = (room: EchoRoom | undefined, id: string): Outcome | undefined => {
    if (!room) return ROOM_NOT_FOUND;
    if (!room.members.includes(store.app.id))
      return { status: 403, body: { ok: false, error: "not_in_room" }, room: id };
    return undefined;
  };

  const handle = (
    method: "GET" | "POST",
    path: string,
    operation: string,
    run: (request: unknown, room: string) => Outcome,
  ) =>
    api.on(method, path, async (c) => {
      const startedAt = context.clock();
      const request: unknown = method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
      const outcome: Outcome = authorized(c.req.header("authorization"))
        ? run(request, c.req.param("room") ?? "")
        : { status: 401, body: { ok: false, error: "invalid_auth" } };
      const session = outcome.room === undefined ? undefined : store.rooms.owner(outcome.room);
      if (session !== undefined) {
        context.events.append(session, "echo", "api_call", {
          operation,
          method,
          path: new URL(c.req.url).pathname,
          request: request ?? null,
          responseStatus: outcome.status,
          response: outcome.body,
          ...(outcome.body.ok ? {} : { error: outcome.body.error }),
          durationMs: context.clock() - startedAt,
        });
      }
      return c.json(outcome.body, outcome.status);
    });

  handle("POST", "/api/messages", "messages.create", (request) => {
    const parsed = PostMessage.safeParse(request);
    if (!parsed.success) return { status: 400, body: { ok: false, error: "invalid_payload" } };
    const room = store.rooms.find(parsed.data.room);
    const refused = refusal(room, parsed.data.room);
    if (refused || !room) return refused ?? ROOM_NOT_FOUND;
    return { status: 200, body: { ok: true, message: world.postAsApp(room, parsed.data.text) }, room: room.id };
  });

  handle("GET", "/api/rooms/:room/messages", "rooms.messages", (_request, id) => {
    const refused = refusal(store.rooms.find(id), id);
    if (refused) return refused;
    return { status: 200, body: { ok: true, messages: store.messagesIn(id).read().items }, room: id };
  });

  api.all("*", (c) => c.json({ ok: false, error: "unknown_method" }, 404));
  return api;
}
