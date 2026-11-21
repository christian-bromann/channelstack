import { z } from "@hono/zod-openapi";
import type { CapabilityTable, DriverRouter } from "../../core/router/index.ts";
import { renderTranscript } from "./transcript.ts";
import type { EchoWorld } from "./world.ts";

const resource = { "x-channelstack-resource": { id: "id" } };
const refTo = (...resources: string[]) => ({ "x-channelstack-ref": resources });

const EchoPrincipal = z
  .object({ id: z.string(), name: z.string(), kind: z.enum(["user", "app"]) })
  .openapi("EchoPrincipal");

const EchoUser = z.object({ id: z.string(), name: z.string(), kind: z.literal("user") }).openapi("EchoUser", resource);

const EchoApp = z
  .object({ id: z.string(), name: z.string(), kind: z.literal("app"), botUserId: z.string() })
  .openapi("EchoApp", resource);

const EchoRoom = z.object({ id: z.string(), name: z.string(), members: z.array(z.string()) }).openapi("EchoRoom", resource);

const EchoFixture = z
  .object({ app: EchoApp, apiUrl: z.string() })
  .openapi("EchoFixture", { "x-channelstack-resource": {} });

const EchoMessage = z
  .object({
    id: z.string(),
    room: z.string(),
    author: EchoPrincipal,
    text: z.string(),
    at: z.string(),
    delivery: z.string().optional(),
  })
  .openapi("EchoMessage");

const EchoMessagePage = z.object({ messages: z.array(EchoMessage), cursor: z.string() }).openapi("EchoMessagePage");

const EchoTranscript = z
  .object({
    entries: z.array(
      z
        .object({
          id: z.string(),
          author: EchoPrincipal,
          at: z.string(),
          text: z.string(),
          controls: z.array(z.string()),
          edited: z.boolean(),
          depth: z.number().int(),
        })
        .openapi("EchoTranscriptEntry"),
    ),
  })
  .openapi("EchoTranscript");

const Capabilities = z
  .record(
    z.string(),
    z.object({ fake: z.boolean(), live: z.boolean(), liveRequires: z.array(z.string()) }).openapi("Capability"),
  )
  .openapi("Capabilities");

const UserParams = z.object({ user: z.string().openapi({ param: { name: "user", in: "path" } }) });
const RoomParams = z.object({ room: z.string().openapi({ param: { name: "room", in: "path" } }) });

/** The echo driver's control API. Every route is experimental: echo exists to prove the pipeline (decision 0003). */
export function registerEchoRoutes(
  router: DriverRouter,
  deps: { world: EchoWorld; apiUrl: () => string; capabilities: CapabilityTable },
): void {
  const { world } = deps;
  const stability = "experimental";

  router.route({
    method: "get",
    path: "",
    summary: "The echo fixture: the agent's app and where it reaches the fake",
    response: EchoFixture,
    factory: { on: "Session", name: "echo" },
    stability,
    handler: () => ({ app: world.app(), apiUrl: deps.apiUrl() }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person",
    body: z.object({ name: z.string().min(1) }).openapi("EchoUserOptions"),
    response: EchoUser,
    factory: { on: "EchoFixture", name: "createUser", options: ["name"] },
    stability,
    handler: ({ session, body }) => world.createUser(session.id, body),
  });

  router.route({
    method: "post",
    path: "/rooms",
    summary: "Create a room. Only the listed participants are members; include the app for it to receive events",
    body: z
      .object({
        name: z.string().min(1).optional(),
        participants: z.array(z.string().openapi(refTo("EchoUser", "EchoApp"))).default([]),
      })
      .openapi("EchoRoomOptions"),
    response: EchoRoom,
    errors: ["not_found"],
    factory: { on: "EchoFixture", name: "createRoom", options: ["name", "participants"] },
    stability,
    handler: ({ session, body }) => world.createRoom(session.id, body),
  });

  router.route({
    method: "post",
    path: "/users/{user}/say",
    summary: "Post a message in a room as this person",
    params: UserParams,
    body: z.object({ text: z.string().min(1), room: z.string().openapi(refTo("EchoRoom")) }).openapi("EchoSayBody"),
    response: EchoMessage,
    errors: ["not_found", "not_in_room"],
    sdkMethod: { on: "EchoUser", name: "say", args: ["text"], options: ["room"] },
    stability,
    handler: ({ session, params, body }) => world.postAsUser(session.id, params.user, body.room, body.text),
  });

  router.route({
    method: "get",
    path: "/rooms/{room}/messages",
    summary: "The room's messages, oldest first, with a cursor for the next read",
    params: RoomParams,
    query: z.object({ since: z.string().optional().openapi({ param: { name: "since", in: "query" } }) }),
    response: EchoMessagePage,
    errors: ["not_found"],
    sdkMethod: { on: "EchoRoom", name: "messages", options: ["since"] },
    stability,
    handler: ({ session, params, query }) => world.messages(session.id, params.room, query.since),
  });

  router.route({
    method: "get",
    path: "/rooms/{room}/transcript",
    summary: "The room as a person would read it",
    params: RoomParams,
    response: EchoTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "EchoRoom", name: "transcript" },
    stability,
    handler: ({ session, params }) => renderTranscript(world.messages(session.id, params.room).messages),
  });

  router.route({
    method: "get",
    path: "/capabilities",
    summary: "Per action: works in the fake, works live, and what live needs",
    response: Capabilities,
    sdkMethod: { on: "EchoFixture", name: "capabilities" },
    stability,
    handler: () => deps.capabilities,
  });
}
