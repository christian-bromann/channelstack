import {
  type DevApi,
  devApp,
  devEnsurePlace,
  devFind,
  devLast,
  devPerson,
  type DevPlace,
  type DevPrincipal,
  devReference,
  DevRefusal,
  devRoot,
  type DevTarget,
  devTarget,
} from "../core/dev/index.ts";
import { type Attached, CliError, segment } from "./attach.ts";
import {
  devApi,
  type DevChannel,
  devChannel,
  type DevFlags,
  refusing,
  runReact,
  runReply,
  runSay,
  runShow,
} from "./dev.ts";
import { type Action, type ActionParam, ACTIONS, type ActionType, HANDLES, TYPES } from "./generated/actions.ts";

/** What a person does on a channel, as the routes have it (generated: `cli/generated/actions.ts`). */
export function actionsOf(channel: string): readonly Action[] {
  return ACTIONS[channel]?.actions ?? [];
}

/** Every value name an action takes on any channel: the values `runChannel` hands an action. */
function actionOptionNames(): string[] {
  return [
    ...new Set(
      Object.values(ACTIONS).flatMap(({ actions }) => actions.flatMap(({ params }) => params.map(({ name }) => name))),
    ),
  ];
}

// --- Describing actions ----------------------------------------------------------------------------

/** A value's type in a few characters, for the tool's description and `channelstack <channel> actions`. */
function typeText(type: ActionType, shorthand?: string): string {
  switch (type.kind) {
    case "ref":
      return type.resources.join(" | ");
    case "array": {
      const items = typeText(type.items);
      return items.includes(" | ") ? `(${items})[]` : `${items}[]`;
    }
    case "enum":
      return type.values.map((value) => JSON.stringify(value)).join(" | ");
    case "literal":
      return JSON.stringify(type.value);
    case "named":
      return shorthand ? `${type.name} (or its ${shorthand})` : type.name;
    case "object": {
      const fields = type.fields.map((field) => `${field.name}${field.optional ? "?" : ""}`).join(", ");
      return `{ ${fields} }${(shorthand ?? type.shorthand) ? ` (or its ${shorthand ?? type.shorthand})` : ""}`;
    }
    case "nullable":
      return `${typeText(type.type)} | null`;
    default:
      return type.kind;
  }
}

/** What a value of an action takes, as `describeAction` writes it: `SlackButtonRef (or its label)`. */
export const paramText = (param: ActionParam): string => typeText(param.type, param.shorthand);

/** `click(button, message?, thread?, channel?): Click a button…`, one line. */
export function describeAction(action: Action): string {
  const params = action.params.map((param) => `${param.name}${param.optional ? "?" : ""}: ${paramText(param)}`);
  return `${action.name}(${params.join(", ")}): ${action.summary}`;
}

/** `channelstack <channel> actions`: what its people do, one per line. */
const runActions = (channel: DevChannel) =>
  `${actionsOf(channel.name)
    .map((action) => `${describeAction(action)}\n`)
    .join("")}`;

// --- Resolving values ----------------------------------------------------------------------------

/** What an action's references are resolved against: the people, the app, and the target's handles. */
interface Scope {
  readonly api: DevApi;
  readonly channel: DevChannel;
  readonly app: DevPrincipal;
  /** The target's handles by name (`adapter.refs`), and the app's. */
  readonly refs: Readonly<Record<string, unknown>>;
  readonly what: string;
}

const looksLikeJson = (value: string) => /^\s*[[{]/.test(value);

/** A handle the target stands for, of the first of these kinds it has. */
const fromTarget = (scope: Scope, resources: readonly string[]) =>
  resources.map((name) => scope.refs[name]).find((value) => value !== undefined);

/** A reference as typed: `last`, a person's name, `app`, an id, or `<field>:<field>` for a handle with several id fields. */
async function reference(scope: Scope, resources: readonly string[], value: unknown): Promise<unknown> {
  if (typeof value !== "string") return value;
  if (value === "last") {
    const found = fromTarget(scope, resources);
    if (found === undefined) throw new CliError(`${scope.what}: \`last\` has no ${resources.join(" or ")}.`);
    return found;
  }
  const roles = resources.map((name) => HANDLES[name]?.role);
  if (roles.includes("app") && [scope.app.id, scope.app.name, "app"].includes(value)) return scope.app.id;
  if (roles.includes("user")) {
    const people = await scope.api.get<DevPrincipal[]>("/users");
    const known = people.find((person) => person.id === value);
    return known ? known.id : (await devPerson(scope.api, scope.channel.adapter, value)).id;
  }
  const id = HANDLES[resources[0] ?? ""]?.id ?? [];
  // An id typed on the command line is text; a handle whose id is a number (a GitHub comment) takes it as one.
  if (id.length < 2) return id[0] ? scalar(id[0].type, value) : value;
  const parts = value.split(":");
  if (parts.length !== id.length) {
    throw new CliError(`${scope.what}: write a ${resources[0]} as ${id.map((field) => `<${field.name}>`).join(":")}.`);
  }
  return Object.fromEntries(id.map((field, at) => [field.name, scalar(field.type, parts[at] as string)]));
}

/** A plain value from text: a number, a boolean, or the text. */
function scalar(type: ActionType, value: string): unknown {
  if (type.kind === "number" || type.kind === "integer") return Number(value);
  if (type.kind === "boolean") return value === "true";
  return value;
}

/** A value as the person gave it (text on the command line, JSON over MCP), as the route takes it. */
async function resolve(scope: Scope, type: ActionType, value: unknown, shorthand?: string): Promise<unknown> {
  switch (type.kind) {
    case "named":
      return resolve(scope, TYPES[type.name] ?? { kind: "unknown" }, value, shorthand);
    case "nullable":
      return value === null ? null : resolve(scope, type.type, value, shorthand);
    case "ref":
      return reference(scope, type.resources, value);
    case "array": {
      const list = typeof value === "string" && looksLikeJson(value) ? JSON.parse(value) : value;
      const items = Array.isArray(list) ? list : [list];
      return Promise.all(items.map((item) => resolve(scope, type.items, item)));
    }
    case "object": {
      const short = shorthand ?? type.shorthand;
      const object =
        typeof value === "string" ? (looksLikeJson(value) || !short ? JSON.parse(value) : { [short]: value }) : value;
      if (typeof object !== "object" || object === null) return object;
      const entries = await Promise.all(
        Object.entries(object as Record<string, unknown>).map(async ([name, inner]) => {
          const field = type.fields.find((candidate) => candidate.name === name);
          return [name, field ? await resolve(scope, field.type, inner) : inner] as const;
        }),
      );
      // A reference the object needs and wasn't given is the target's, as for an action's own values.
      for (const field of type.fields) {
        if (field.optional || entries.some(([name]) => name === field.name) || field.type.kind !== "ref") continue;
        const found = fromTarget(scope, field.type.resources);
        if (found !== undefined) entries.push([field.name, found]);
      }
      return Object.fromEntries(entries);
    }
    case "number":
    case "integer":
    case "boolean":
      return typeof value === "string" ? scalar(type, value) : value;
    case "string":
    case "enum":
    case "literal":
    case "duration":
    case "pattern":
      return value;
    default:
      return typeof value === "string" && looksLikeJson(value) ? JSON.parse(value) : value;
  }
}

const isRef = (type: ActionType): type is Extract<ActionType, { kind: "ref" }> => type.kind === "ref";
const refOf = (type: ActionType) =>
  isRef(type) ? type : type.kind === "array" && isRef(type.items) ? type.items : undefined;

/**
 * A value left out, from the target: a reference the action needs (the message, the issue, the
 * app), and the place itself when the action takes it but no reference at all was given.
 */
function filled(scope: Scope, param: ActionParam, nothingGiven: boolean): unknown {
  const ref = refOf(param.type);
  if (!ref) return undefined;
  const placeOnly = param.optional && nothingGiven && ref.resources.includes(scope.channel.adapter.resource);
  if (param.optional && !placeOnly) return undefined;
  const found = fromTarget(scope, placeOnly ? [scope.channel.adapter.resource] : ref.resources);
  return found === undefined || ref === param.type ? found : [found];
}

export interface ActFlags {
  as?: string | undefined;
  in?: string | undefined;
  on?: string | undefined;
  json?: boolean | undefined;
}

/** A sentence for what an action answered: its id, when it has one. */
function answered(result: unknown): string {
  if (result === null || result === undefined || typeof result !== "object") return "";
  const { id } = result as { id?: unknown };
  return typeof id === "string" || typeof id === "number" ? ` (${id})` : "";
}

/**
 * `channelstack <channel> <action>` and `<channel>_act`: one of the channel's actions, as a person.
 * Values come by name (`values`) or in order (`positional`); references the action needs and
 * weren't given are the target's: the entry `--on` names, the newest one `--in` a place, or `last`.
 * Who acts is `--as`, or else whoever started the target's thread.
 */
export async function runAct(
  server: Attached,
  channel: DevChannel,
  name: string | undefined,
  input: { positional: readonly string[]; values: Readonly<Record<string, unknown>>; flags: ActFlags },
): Promise<string> {
  return refusing(async () => {
    const action = actionsOf(channel.name).find((candidate) => candidate.name === name);
    if (!action) {
      throw new CliError(
        `${channel.title} has no action "${name ?? ""}". \`channelstack ${channel.name} actions\` lists them.`,
      );
    }
    const { adapter } = channel;
    const { flags } = input;
    const api = await devApi(server, channel.name);
    const app = await devApp(api);

    /** A place's newest entry, or the place itself while nothing was said in it. */
    const newestOf = (place: DevPlace) =>
      devTarget(api, adapter, place.id).catch((error: unknown) => {
        if (error instanceof DevRefusal) return { place, entries: [], index: -1 };
        throw error;
      });
    let target: DevTarget | undefined;
    if (flags.on !== undefined) target = await devTarget(api, adapter, flags.on);
    else if (flags.in !== undefined) {
      const known = await devFind(api, adapter, flags.in);
      target = known ? await newestOf(known) : undefined;
    } else target = await devLast(api, adapter);

    let person: DevPrincipal;
    if (flags.as !== undefined) person = await devPerson(api, adapter, flags.as);
    else {
      const root = target ? devRoot(target)?.author : undefined;
      if (root?.kind !== "user") throw new CliError("say who acts with `--as <name>`.");
      person = root;
    }
    if (flags.in !== undefined && target === undefined) {
      // A place named for the first time is made, with the person and the app in it.
      const { place } = await devEnsurePlace({ api, adapter, person, app, name: flags.in });
      // A new GitHub or Linear issue has its description as its first entry already.
      target = await newestOf(place);
    }
    if (target && target.index >= 0) await adapter.enter?.({ api, person, app, place: target.place });

    const refs = {
      ...(target === undefined
        ? {}
        : target.index >= 0
          ? await adapter.refs(api, target)
          : { [adapter.resource]: target.place.id }),
      [ACTIONS[channel.name]?.app ?? ""]: app.id,
    };
    const scope: Scope = { api, channel, app, refs, what: `${channel.name} ${action.name}` };

    const given = new Map<string, unknown>();
    action.params
      .filter((param) => param.positional)
      .forEach((param, at) => {
        if (input.positional[at] !== undefined) given.set(param.name, input.positional[at]);
      });
    for (const [key, value] of Object.entries(input.values)) {
      if (value === undefined) continue;
      if (!action.params.some((param) => param.name === key)) {
        throw new CliError(`${channel.name} ${action.name} takes no "${key}". It takes: ${describeAction(action)}`);
      }
      given.set(key, value);
    }
    const nothingGiven = !action.params.some((param) => given.has(param.name) && refOf(param.type));
    const body: Record<string, unknown> = {};
    const query = new URLSearchParams();
    for (const param of action.params) {
      const value = given.has(param.name)
        ? await resolve(scope, param.type, given.get(param.name), param.shorthand)
        : filled(scope, param, nothingGiven);
      if (value === undefined) continue;
      if (param.in === "query") query.set(param.name, typeof value === "string" ? value : JSON.stringify(value));
      else body[param.name] = value;
    }
    const path = action.path.replace("{user}", segment(person.id));
    const search = query.size > 0 ? `?${query}` : "";
    const base = `/sessions/${segment(await server.devSession())}/${channel.name}`;
    const result = await server.request(action.method, `${base}${path}${search}`, body);
    if (flags.json) return `${JSON.stringify(result ?? null, null, 2)}\n`;
    const where =
      target && target.index >= 0 ? ` on ${devReference(target)}` : target ? ` in ${target.place.name}` : "";
    return `${person.name} did ${action.name}${where}${answered(result)}\n`;
  });
}

/** The shared verbs, which every channel has; anything else is one of the channel's actions. */
export const VERBS = ["say", "reply", "react", "show", "actions", "act"] as const;

/**
 * `channelstack <channel> <verb|action> …`: `say`, `reply`, `react`, `show`, `actions`, and each of
 * the channel's actions by name (`act <action>` too, for one named like a verb: Slack's own `say`).
 */
export async function runChannel(
  server: Attached,
  name: string | undefined,
  verb: string | undefined,
  args: readonly string[],
  values: Readonly<Record<string, unknown>> & DevFlags,
): Promise<string> {
  const channel = devChannel(name);
  const [first, ...rest] = args;
  if (verb === "say") return runSay(server, channel, first, values);
  if (verb === "reply") return runReply(server, channel, first, values);
  if (verb === "react") return runReact(server, channel, first, values);
  if (verb === "show") return runShow(server, channel, values);
  if (verb === "actions") return runActions(channel);
  const [action, positional] = verb === "act" ? [first, rest] : [verb, args];
  if (action === undefined) {
    throw new CliError(
      `what on ${channel.title}? Try ${VERBS.map((known) => `\`${known}\``).join(", ")}, or an action.`,
    );
  }
  const names = new Set(actionOptionNames());
  const given = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => names.has(key) && value !== undefined),
  );
  return runAct(server, channel, action, { positional, values: given, flags: values });
}
