import type { MessagePlace } from "../router/driver.ts";

/** Where each id of a place is in a delivery's body, as dotted paths tried in order (`sender.id`). */
export type PlacePaths = Readonly<Record<keyof Omit<MessagePlace, "channel">, readonly string[]>>;

/** A delivery's body as JSON: the body itself, or a form's JSON `payload` (a Slack interaction). */
function jsonOf(body: string): unknown {
  const trimmed = body.trim();
  try {
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);
    const payload = new URLSearchParams(trimmed).get("payload");
    return payload === null ? undefined : JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/** The value at a dotted path, as an id: a string, or a number as text. */
function at(value: unknown, path: string): string | undefined {
  let here = value;
  for (const key of path.split(".")) {
    if (typeof here !== "object" || here === null) return undefined;
    here = (here as Record<string, unknown>)[key];
  }
  if (typeof here === "number") return String(here);
  return typeof here === "string" && here !== "" ? here : undefined;
}

/**
 * Where the message a delivery tells the agent about is: who wrote it, the conversation, the
 * thread and the message, each the first of its paths the body has. Each driver names its
 * platform's paths (`Driver.place`); this reads them.
 */
export function placeFrom(body: string, paths: PlacePaths): Omit<MessagePlace, "channel"> | undefined {
  const json = jsonOf(body);
  if (json === undefined) return undefined;
  const place: Record<string, string> = {};
  for (const [key, candidates] of Object.entries(paths)) {
    const found = candidates.map((path) => at(json, path)).find((value) => value !== undefined);
    if (found !== undefined) place[key] = found;
  }
  return Object.keys(place).length === 0 ? undefined : place;
}
