import type { EchoApp, EchoMessage } from "./world.ts";

/** The `message.created` event the echo platform sends when someone posts in a room the app is in. */
export function messageCreated(input: { deliveryId: string; app: EchoApp; message: EchoMessage; atMs: number }) {
  return {
    type: "message.created",
    event_id: input.deliveryId,
    event_time: Math.floor(input.atMs / 1000),
    app_id: input.app.id,
    message: {
      id: input.message.id,
      room: input.message.room,
      author: input.message.author,
      text: input.message.text,
      at: input.message.at,
    },
  };
}
