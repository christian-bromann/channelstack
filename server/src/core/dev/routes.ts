import { type OpenAPIHono, z } from "@hono/zod-openapi";

import { ProtocolError } from "../errors/index.ts";
import { pathParam, registerRoute, SessionParams } from "../router/index.ts";
import { principalSchema, transcriptSchema } from "../router/inspect.ts";
import type { Sessions } from "../sessions/index.ts";
import { type DevAdapter, type DevApi, devEverywhere, devFind, devTime } from "./index.ts";

/** A channel as the place routes are handed it: its name, and its dev adapter. */
interface PlaceChannel {
  readonly name: string;
  readonly title: string;
  readonly adapter: DevAdapter;
}

const Place = z
  .object({
    channel: z.string(),
    title: z.string().openapi({ description: "The channel's name as people write it: `GitHub`." }),
    id: z.string().openapi({ description: "How a reference writes it: `<id>:<entry id>` names one of its entries." }),
    name: z
      .string()
      .openapi({ description: "What a person calls it: `#support`, an issue's or a page's title, a subject." }),
    active: z
      .string()
      .optional()
      .openapi({ description: "When its newest entry was written. Absent while nothing was said in it." }),
  })
  .openapi("Place", { "x-channelstack-resource": { id: ["channel", "id"] } });

const PlacePrincipal = principalSchema("PlacePrincipal");
const PlaceTranscript = transcriptSchema("Place", PlacePrincipal, {
  streaming: z
    .enum(["open", "stopped", "completed"])
    .optional()
    .openapi({ description: "A message the agent streams (Slack)." }),
  // An ephemeral message's one reader (Slack).
  visibleTo: PlacePrincipal.optional(),
});

/**
 * The dev tools' places on every channel, for the UI and the SDKs: each channel's places as its dev
 * adapter names them, in the order `last` reads them (`devEverywhere`), and each one's transcript.
 * `api` is a channel's control API in a session, called in process.
 */
export function registerPlaceRoutes(
  app: OpenAPIHono,
  options: {
    sessions: Sessions;
    channels: readonly PlaceChannel[];
    api: (session: string, channel: string) => DevApi;
  },
): void {
  const { sessions, channels, api } = options;
  const apis = (session: string) => channels.map((channel) => ({ ...channel, api: api(session, channel.name) }));

  registerRoute(app, {
    method: "get",
    path: "/sessions/{session}/places",
    summary:
      "Every channel's places in the session, as the dev tools name them (a Slack channel, a GitHub issue, a Notion page, an email thread), the most recently active last",
    params: SessionParams,
    response: z.array(Place).openapi("Places"),
    errors: ["session_not_found"],
    sdkMethod: { on: "Session", name: "places" },
    stability: "experimental",
    handler: async ({ params }) =>
      (await devEverywhere(apis(sessions.get(params.session).id))).map(({ channel, place, newest }) => ({
        channel,
        title: channels.find((candidate) => candidate.name === channel)?.title ?? channel,
        id: place.id,
        name: place.name,
        ...(newest === undefined ? {} : { active: new Date(devTime(newest)).toISOString() }),
      })),
  });

  registerRoute(app, {
    method: "get",
    path: "/sessions/{session}/places/{channel}/{place}/transcript",
    summary: "A place as a person reads it: the transcript its channel's own transcript route has",
    params: SessionParams.extend({ channel: pathParam("channel"), place: pathParam("place") }),
    response: PlaceTranscript,
    errors: ["session_not_found", "not_found"],
    sdkMethod: { on: "Place", name: "transcript", bind: { channel: "channel", place: "id" } },
    stability: "experimental",
    handler: async ({ params }) => {
      const session = sessions.get(params.session).id;
      const channel = channels.find((candidate) => candidate.name === params.channel);
      if (!channel) throw new ProtocolError("not_found", `No channel "${params.channel}"`);
      const channelApi = api(session, channel.name);
      const place = await devFind(channelApi, channel.adapter, params.place);
      if (!place) throw new ProtocolError("not_found", `No place "${params.place}" on ${channel.name} in this session`);
      return channelApi.get<z.input<typeof PlaceTranscript>>(place.transcript);
    },
  });
}
