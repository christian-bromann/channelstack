import { readFileSync } from "node:fs";

import { openApiChecks } from "./openapi.ts";

// Read at run time: at 1.2 MB, importing it would make the type checker infer a type for all of it.
const description = JSON.parse(readFileSync(new URL("./discord-openapi.json", import.meta.url), "utf8")) as Record<
  string,
  unknown
>;

/**
 * Discord's own description of its REST API (`discord/discord-api-spec`, pinned by
 * `scripts/pinned-schema.ts`), as validators. Exit check 11.2 holds every answer of the fake to it,
 * and every Gateway dispatch whose object it describes: a message, a channel, a thread.
 */
const checks = openApiChecks(description, { name: "Discord", prefix: /^\/api\/v\d+/, errors: true });

/** The schema of the object a Gateway dispatch carries, where the description has one. */
const DISPATCHED: Readonly<Record<string, string>> = {
  MESSAGE_CREATE: "MessageResponse",
  MESSAGE_UPDATE: "MessageResponse",
  CHANNEL_CREATE: "GuildChannelResponse",
  CHANNEL_UPDATE: "GuildChannelResponse",
  GUILD_CREATE: "GuildResponse",
  THREAD_CREATE: "ThreadResponse",
};

/** A 50035's field errors with their codes as the description types them: integers. */
const withIntegerCodes = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withIntegerCodes);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      key === "_errors" && Array.isArray(inner)
        ? inner.map((error) => ({ ...(error as object), code: 0 }))
        : withIntegerCodes(inner),
    ]),
  );
};

/**
 * What Discord's description says about one answer of the API, its refusals included: nothing when
 * it fits. Two things it can't hold: a path that isn't Discord's at all (its 404 is Discord's
 * `404: Not Found`, checked by the driver's tests), and a 50035's field errors, whose codes are
 * strings (`BASE_TYPE_MAX_LENGTH`), as Discord sends them, where the description types them as
 * integers: those are held with integers in their place.
 */
export function discordResponseProblems(method: string, path: string, status: number, body: unknown): string[] {
  const held =
    status === 400 && typeof body === "object" && body !== null && "errors" in body
      ? { ...body, errors: withIntegerCodes((body as { errors: unknown }).errors) }
      : body;
  return checks
    .response(method, path, status, held)
    .filter((problem) => !(status === 404 && problem.endsWith("not in Discord's description")));
}

/** What it says about one Gateway dispatch, or an interaction's body: nothing for what it doesn't describe. */
export function discordDispatchProblems(type: string, payload: unknown): string[] {
  const schema = DISPATCHED[type];
  return schema ? checks.schema(["components", "schemas", schema], payload, `dispatch ${type}`) : [];
}
