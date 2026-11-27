/**
 * The dev adapter: how the dev tools (the attach CLI, `channelstack mcp` and the UI) act on a
 * channel in the shared `dev` session by the names a person types (`ana`, `#support`, `Login
 * fails`) and by `last`, instead of by ids. Each channel's driver has one (`definition.dev`), written
 * against the channel's control API, so it works the same from the terminal, over MCP and in the
 * UI. What is the same for every channel is here, once; decision 0027 says why.
 */

/** A channel's control API in the dev session: paths are relative to `/sessions/<dev>/<channel>`. */
export interface DevApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** A mistake in what the person asked for, to tell them in a sentence. */
export class DevRefusal extends Error {}

/** A person or the agent's app, as every channel's control API has them. */
export interface DevPrincipal {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

/** One entry of a transcript: every channel's transcript has these fields. */
export interface DevEntry {
  readonly id: string;
  readonly author: DevPrincipal;
  readonly at: string;
  readonly text: string;
  readonly depth: number;
  readonly controls: readonly string[];
}

interface DevTranscript {
  readonly entries: readonly DevEntry[];
  readonly text: string;
}

/**
 * How a channel lists its places (its Slack channels, GitHub issues, email threads), as plain
 * data, so the UI page reads the same declaration. Templates name fields of a listed item:
 * `"/conversations/{id}/transcript"`, `"{repo.fullName}#{number}"`.
 */
interface DevListing {
  /** The list route, e.g. `/conversations`. */
  readonly path: string;
  /** How a place is written in a reference (`<place>:<entry>`). Never has a `:`. */
  readonly id: string;
  /** What a person calls it: the first template whose fields the item has. */
  readonly name: readonly string[];
  /** Its transcript route. */
  readonly transcript: string;
}

/** A place the dev tools found: its id and name, its transcript route, and the item as listed. */
export interface DevPlace {
  readonly id: string;
  readonly name: string;
  readonly transcript: string;
  readonly item: Readonly<Record<string, unknown>>;
}

/** An entry of a place, which `last`, a reference and `--on` point at. */
export interface DevTarget {
  readonly place: DevPlace;
  readonly entries: readonly DevEntry[];
  /** Where the entry is in `entries`. */
  readonly index: number;
  /** When the entry was written, in milliseconds, as precisely as its channel tells (`DevAdapter.time`). */
  readonly time?: number;
}

/** Who acts and where: what each of the adapter's actions is handed. */
interface DevActing {
  readonly api: DevApi;
  readonly person: DevPrincipal;
  readonly app: DevPrincipal;
}

/** What differs between channels. The rest (names, `last`, references, transcripts) is the kit's, below. */
export interface DevAdapter {
  /** What a place is on the channel, for messages: `channel`, `issue`, `page`, `thread`. */
  readonly place: string;
  /** How to name one, for messages: `"#support"`. */
  readonly example: string;
  /** The handle a place is (`SlackConversation`): act fills a reference to it in when none is given. */
  readonly resource: string;
  readonly listing: DevListing;
  /** The body of `POST /users` that makes a person of this name. */
  personBody(name: string): unknown;
  /**
   * Make the place `name` with the app in it, the person able to act there, and, with `text`,
   * the person's first words in it. Returns the new item, as the listing has it.
   */
  create(acting: DevActing & { name: string; text: string | undefined }): Promise<Record<string, unknown>>;
  /** Let the person into a place they aren't in yet (Slack: someone in it invites them). */
  enter?(acting: DevActing & { place: DevPlace }): Promise<void>;
  say(acting: DevActing & { place: DevPlace; text: string }): Promise<void>;
  reply(acting: DevActing & { target: DevTarget; text: string }): Promise<void>;
  /** For a channel whose people react. */
  react?(acting: DevActing & { target: DevTarget; emoji: string }): Promise<void>;
  /** The handles a target stands for, by handle name, as act sends them: the place, the entry, its thread. */
  refs(api: DevApi, target: DevTarget): Promise<Record<string, unknown>>;
  /** The transcript route of only the target's thread. Without it, or when it says nothing, the whole place. */
  thread?(api: DevApi, target: DevTarget): Promise<string | undefined>;
  /** When an entry was written, more precisely than its `at` (Slack's `ts`, to the microsecond). */
  time?(entry: DevEntry): number;
  /** The newest entry of a place, for a channel whose transcript's order and times don't tell (Slack's threads). */
  newest?(api: DevApi, place: DevPlace): Promise<string | undefined>;
}

// --- Templates -------------------------------------------------------------------------------

/** A field of an item by its dotted path. */
const field = (item: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], item);

/** A template with the item's fields filled in, or nothing when one of them is missing. */
function fill(template: string, item: unknown): string | undefined {
  let missing = false;
  const text = template.replace(/\{([\w.]+)\}/g, (_, path: string) => {
    const value = field(item, path);
    if (value === undefined || value === null || value === "") missing = true;
    return String(value ?? "");
  });
  return missing ? undefined : text;
}

/** A route from a template: the same, but each field stays encoded as a path segment. */
const route = (template: string, item: unknown): string =>
  template.replace(/\{([\w.]+)\}/g, (_, path: string) => encodeURIComponent(String(field(item, path) ?? "")));

// --- People and places -------------------------------------------------------------------------

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The person of this name, made the first time the name is used. */
export async function devPerson(api: DevApi, adapter: DevAdapter, name: string | undefined): Promise<DevPrincipal> {
  if (!name) throw new DevRefusal("say who is acting with `--as <name>`, e.g. `--as ana`.");
  const people = await api.get<DevPrincipal[]>("/users");
  return people.find((known) => same(known.name, name)) ?? api.post<DevPrincipal>("/users", adapter.personBody(name));
}

/** The agent's app, from the channel's fixture. */
export const devApp = async (api: DevApi): Promise<DevPrincipal> => (await api.get<{ app: DevPrincipal }>("")).app;

function placeOf(adapter: DevAdapter, item: Record<string, unknown>): DevPlace {
  const { listing } = adapter;
  const id = fill(listing.id, item) ?? "";
  const name = listing.name.map((template) => fill(template, item)).find((text) => text !== undefined) ?? id;
  return { id, name, transcript: route(listing.transcript, item), item };
}

/** The channel's places, as its list route has them. */
async function devPlaces(api: DevApi, adapter: DevAdapter): Promise<DevPlace[]> {
  return (await api.get<Array<Record<string, unknown>>>(adapter.listing.path)).map((item) => placeOf(adapter, item));
}

/** `#support` and `support` name the same Slack channel; names are matched without case. */
const plain = (name: string) => name.replace(/^#/, "").toLowerCase();

/** The place a person names: by its name, or by its id as a reference writes it. */
export async function devFind(api: DevApi, adapter: DevAdapter, name: string): Promise<DevPlace | undefined> {
  const places = await devPlaces(api, adapter);
  return places.findLast((place) => plain(place.name) === plain(name)) ?? places.find((place) => same(place.id, name));
}

/** The place this person names, made with the app in it the first time (with `text`, as their first words). */
export async function devEnsurePlace(
  acting: DevActing & { adapter: DevAdapter; name: string | undefined; text?: string },
): Promise<{ place: DevPlace; created: boolean }> {
  const { adapter, name, api } = acting;
  if (!name) throw new DevRefusal(`say where with \`--in ${adapter.example}\`.`);
  const found = await devFind(api, adapter, name);
  if (found) {
    await adapter.enter?.({ ...acting, place: found });
    return { place: found, created: false };
  }
  const item = await adapter.create({ ...acting, name: name.replace(/^#/, ""), text: acting.text });
  return { place: placeOf(adapter, item), created: true };
}

// --- Transcripts, `last` and references -----------------------------------------------------------

export const devTranscript = (api: DevApi, path: string) => api.get<DevTranscript>(path);

/** When an entry was written, as an instant: channels write their times to different precisions. */
const instant = (entry: DevEntry | undefined) =>
  entry === undefined ? Number.NEGATIVE_INFINITY : Date.parse(entry.at);

/** When a target's entry was written; before everything for a place nothing was said in. */
export const devTime = (target: DevTarget | undefined): number =>
  target === undefined ? Number.NEGATIVE_INFINITY : (target.time ?? instant(target.entries[target.index]));

/** The newest entry of a list of entries: the latest time, and of equal times the one listed later. */
function newestIndex(entries: readonly DevEntry[]): number {
  let newest = -1;
  entries.forEach((entry, index) => {
    if (newest === -1 || instant(entry) >= instant(entries[newest])) newest = index;
  });
  return newest;
}

/** A place's newest entry, as a target. Nothing when the place has no entries yet. */
async function newestIn(api: DevApi, adapter: DevAdapter, place: DevPlace): Promise<DevTarget | undefined> {
  const { entries } = await devTranscript(api, place.transcript);
  if (entries.length === 0) return undefined;
  const id = await adapter.newest?.(api, place);
  const index = id === undefined ? newestIndex(entries) : entries.findIndex((entry) => entry.id === id);
  const entry = entries[index];
  return entry === undefined ? undefined : { place, entries, index, time: adapter.time?.(entry) ?? instant(entry) };
}

/**
 * A channel's places with their newest entries, the most recently active last: of places whose
 * newest entries are as new, the one its list route lists later; places nothing was said in first.
 * What `last` means, and the order the UI lists places in.
 */
async function devActivity(
  api: DevApi,
  adapter: DevAdapter,
): Promise<Array<{ place: DevPlace; newest: DevTarget | undefined }>> {
  const active: Array<{ place: DevPlace; newest: DevTarget | undefined; order: number }> = [];
  for (const [order, place] of (await devPlaces(api, adapter)).entries()) {
    active.push({ place, newest: await newestIn(api, adapter, place), order });
  }
  return active
    .sort((a, b) => byTime(a.newest, b.newest) || a.order - b.order)
    .map(({ place, newest }) => ({ place, newest }));
}

/** Older first; nothing said before anything was. */
function byTime(a: DevTarget | undefined, b: DevTarget | undefined): number {
  const [left, right] = [devTime(a), devTime(b)];
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every channel's places, the most recently active last, as `devActivity` orders one channel's:
 * of places as new, the one of the channel listed later. `channelstack show` shows the last;
 * the UI lists them in this order.
 */
export async function devEverywhere(
  channels: ReadonlyArray<{ readonly name: string; readonly adapter: DevAdapter; readonly api: DevApi }>,
): Promise<Array<{ channel: string; place: DevPlace; newest: DevTarget | undefined }>> {
  const all: Array<{ channel: string; place: DevPlace; newest: DevTarget | undefined }> = [];
  for (const { name, adapter, api } of channels) {
    for (const active of await devActivity(api, adapter)) all.push({ channel: name, ...active });
  }
  // Sorting is stable, so places as new keep the order of their channels.
  return all.sort((a, b) => byTime(a.newest, b.newest));
}

/** What `last` means on a channel: the newest entry of its most recently active place (`devActivity`). */
export async function devLast(api: DevApi, adapter: DevAdapter): Promise<DevTarget | undefined> {
  return (await devActivity(api, adapter)).at(-1)?.newest;
}

/** How a reference writes a target: `<place>:<entry>`. */
export const devReference = (target: DevTarget): string => `${target.place.id}:${target.entries[target.index]?.id}`;

/**
 * A target from what a person typed: `last` (or nothing), a place by name or id (its newest
 * entry), or a reference (`<place>:<entry>`, as the commands print them and `show --json` lists
 * the entries). A place whose name has a `:` is found by its name before the text is split.
 */
export async function devTarget(api: DevApi, adapter: DevAdapter, reference: string | undefined): Promise<DevTarget> {
  if (reference === undefined || reference === "last") {
    const last = await devLast(api, adapter);
    if (!last) throw new DevRefusal(`nothing has been said yet. Start with \`say --in ${adapter.example}\`.`);
    return last;
  }
  const named = await devFind(api, adapter, reference);
  if (named) {
    const newest = await newestIn(api, adapter, named);
    if (!newest) throw new DevRefusal(`nothing has been said in ${named.name} yet.`);
    return newest;
  }
  const colon = reference.lastIndexOf(":");
  const place = colon === -1 ? undefined : await devFind(api, adapter, reference.slice(0, colon));
  if (!place) throw new DevRefusal(`there is no ${adapter.place} "${reference}". Name one, or use \`last\`.`);
  const { entries } = await devTranscript(api, place.transcript);
  const entry = reference.slice(colon + 1);
  const index = entries.findIndex((candidate) => candidate.id === entry);
  if (index === -1) throw new DevRefusal(`${place.name} has no entry "${entry}": \`show --json\` lists them.`);
  return { place, entries, index };
}

/**
 * The entry of the target's thread that started it: the nearest one at depth 0, the target's own
 * included. Nothing for a place nothing was said in.
 */
export function devRoot(target: DevTarget): DevEntry | undefined {
  for (let index = target.index; index >= 0; index -= 1) {
    const entry = target.entries[index];
    if (entry?.depth === 0) return entry;
  }
  return target.entries[0];
}

/** The newest entry by this person in a place: what a person just said there. */
export async function devSaid(api: DevApi, place: DevPlace, person: DevPrincipal): Promise<DevTarget | undefined> {
  const { entries } = await devTranscript(api, place.transcript);
  const theirs = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.author.id === person.id);
  const newest = newestIndex(theirs.map(({ entry }) => entry));
  return newest === -1 ? undefined : { place, entries, index: (theirs[newest] as { index: number }).index };
}
