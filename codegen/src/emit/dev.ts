/**
 * The dev tools' actions, generated from the IR like the SDKs: per channel, everything its people
 * do (each method of its person handle that isn't a read), with the values each one takes. The
 * attach CLI (`channelstack <channel> <action>`) and `channelstack mcp` (`<channel>_act`) are built
 * on it, so a new action on the routes is a new action there with no hand-written list. Decision 0028.
 */
import type { Ir, IrField, IrParam, IrType } from "../ir.ts";
import { channelGlue } from "./channels.ts";
import { BANNER, IrIndex } from "./shared.ts";

const FILE = "server/src/cli/generated/actions.ts";

interface Collected {
  handles: Set<string>;
  types: Set<string>;
}

/** The handles and named types a value can hold, so the file carries what resolving it needs. */
function collect(type: IrType, into: Collected, named: ReadonlyMap<string, IrType>): void {
  const inner = (member: IrType) => collect(member, into, named);
  switch (type.kind) {
    case "ref":
      for (const name of type.resources) into.handles.add(name);
      break;
    case "array":
      inner(type.items);
      break;
    case "record":
      inner(type.values);
      break;
    case "nullable":
      inner(type.type);
      break;
    case "object":
      for (const field of type.fields) inner(field.type);
      break;
    case "union":
      for (const member of type.types) inner(member);
      break;
    case "named": {
      if (into.types.has(type.name)) break;
      into.types.add(type.name);
      const definition = named.get(type.name);
      if (definition) inner(definition);
      break;
    }
    default:
      break;
  }
}

const field = ({ name, type, optional }: IrField) => ({ name, type, optional });

export function emitDev(ir: Ir): Map<string, string> {
  const index = new IrIndex(ir);
  const glue = channelGlue(ir);
  const named = new Map(ir.types.map((type) => [type.name, type.type]));
  const collected: Collected = { handles: new Set(), types: new Set() };

  const channels = glue.channels.map(({ name, title }) => {
    const user = glue.users.find((candidate) => candidate === `${title}User`);
    const app = glue.apps.find((candidate) => index.resource(candidate).name.startsWith(title));
    if (!user || !app) throw new Error(`${title} has no person handle (${title}User) or no app handle`);
    const prefix = `/sessions/{session}/${name}`;
    const actions = index
      .resource(user)
      .methods.filter((method) => method.http.verb !== "GET")
      .map((method) => {
        if (!method.http.path.startsWith(prefix)) throw new Error(`${user}.${method.name} isn't under ${prefix}`);
        const param = (positional: boolean) => (input: IrParam) => {
          collect(input.type, collected, named);
          return {
            ...field(input),
            in: input.in,
            positional,
            ...(input.shorthand === undefined ? {} : { shorthand: input.shorthand }),
          };
        };
        return {
          name: method.name,
          summary: method.summary,
          method: method.http.verb,
          path: method.http.path.slice(prefix.length),
          params: [...method.args.map(param(true)), ...method.options.map(param(false))],
        };
      });
    return [name, { user, app, actions }] as const;
  });

  const handles = [...collected.handles].sort().map((name) => {
    const resource = index.resource(name);
    const ids = new Set(resource.idFields ?? []);
    return [
      name,
      {
        ...(resource.role === undefined ? {} : { role: resource.role }),
        id: resource.fields.filter((candidate) => ids.has(candidate.name)).map(field),
      },
    ] as const;
  });
  const types = [...collected.types].sort().map((name) => [name, named.get(name) ?? { kind: "unknown" }] as const);

  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const source = `// ${BANNER}

/** A value an action takes, as the IR describes it. */
export type ActionType =
  | { readonly kind: "string" | "number" | "integer" | "boolean" | "unknown" | "duration" | "pattern" }
  | { readonly kind: "literal"; readonly value: string | boolean }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "array"; readonly items: ActionType; readonly oneOrMany?: true }
  | { readonly kind: "record"; readonly values: ActionType }
  | { readonly kind: "object"; readonly fields: readonly ActionField[]; readonly shorthand?: string }
  | { readonly kind: "files"; readonly mode: "tree" | "changes" | "document" }
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "resource"; readonly name: string }
  | { readonly kind: "ref"; readonly resources: readonly string[] }
  | { readonly kind: "nullable"; readonly type: ActionType }
  | { readonly kind: "union"; readonly types: readonly ActionType[]; readonly discriminator?: string };

export interface ActionField {
  readonly name: string;
  readonly type: ActionType;
  readonly optional: boolean;
}

/** A body or query field of an action; \`positional\` ones come first on the command line, in order. */
export interface ActionParam extends ActionField {
  readonly in: "body" | "query";
  readonly positional: boolean;
  /** A plain string stands for \`{ [shorthand]: string }\`. */
  readonly shorthand?: string;
}

/** One thing a person does: \`path\` is under the channel's routes and has \`{user}\`, the person acting. */
export interface Action {
  readonly name: string;
  readonly summary: string;
  readonly method: "POST" | "DELETE";
  readonly path: string;
  readonly params: readonly ActionParam[];
}

/** Each channel's person handle, its app's, and what its people do. */
export const ACTIONS: Readonly<Record<string, { readonly user: string; readonly app: string; readonly actions: readonly Action[] }>> = ${json(Object.fromEntries(channels))};

/** The handles the actions refer to: what each is on its channel, and the fields its id is sent as. */
export const HANDLES: Readonly<Record<string, { readonly role?: "user" | "app" | "resource"; readonly id: readonly ActionField[] }>> = ${json(Object.fromEntries(handles))};

/** The named types the actions' values use. */
export const TYPES: Readonly<Record<string, ActionType>> = ${json(Object.fromEntries(types))};
`;
  return new Map([[FILE, source]]);
}
