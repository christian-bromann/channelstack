import {
  buildSchema,
  type DocumentNode,
  execute,
  type ExecutionResult,
  type FragmentDefinitionNode,
  GraphQLError,
  type GraphQLFieldResolver,
  type GraphQLOutputType,
  type GraphQLSchema,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  parse,
  type SelectionSetNode,
  specifiedRules,
  validate,
  type ValidationContext,
} from "graphql";

import { LINEAR_SCHEMA } from "../schema/schema.ts";

let built: GraphQLSchema | undefined;

/** Linear's schema, built once: the one the fake executes against and the tests hold it to. */
export function linearSchema(): GraphQLSchema {
  built ??= buildSchema(LINEAR_SCHEMA);
  return built;
}

/** How deep an operation may nest: what Linear's SDK asks for fits well within it. */
const MAX_DEPTH = 15;

/** A rule next to GraphQL's own: refuse an operation that nests deeper than `MAX_DEPTH`. */
function maxDepth(context: ValidationContext) {
  const fragments = new Map(
    context
      .getDocument()
      .definitions.filter(
        (definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((fragment) => [fragment.name.value, fragment]),
  );
  const depth = (set: SelectionSetNode | undefined, seen: ReadonlySet<string>): number => {
    if (!set) return 0;
    let deepest = 0;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) deepest = Math.max(deepest, 1 + depth(selection.selectionSet, seen));
      else if (selection.kind === Kind.INLINE_FRAGMENT)
        deepest = Math.max(deepest, depth(selection.selectionSet, seen));
      else if (!seen.has(selection.name.value)) {
        const fragment = fragments.get(selection.name.value);
        deepest = Math.max(deepest, depth(fragment?.selectionSet, new Set([...seen, selection.name.value])));
      }
    }
    return deepest;
  };
  return {
    OperationDefinition(node: { selectionSet: SelectionSetNode }) {
      if (depth(node.selectionSet, new Set()) > MAX_DEPTH) {
        context.reportError(new GraphQLError(`Query too deep: more than ${MAX_DEPTH} levels`));
      }
    },
  };
}

/**
 * A refusal the way Linear answers one: a GraphQL error with Linear's extensions. `code` is what
 * Linear puts there (`INPUT_ERROR`, `FORBIDDEN`, `AUTHENTICATION_ERROR`), `type` its category.
 */
export class LinearError extends GraphQLError {
  constructor(message: string, code = "INPUT_ERROR", type = "invalid input", userMessage = message) {
    super(message, {
      extensions: { type, code, statusCode: 400, userError: true, userPresentableMessage: userMessage },
    });
  }
}

export const notFound = (entity: string) =>
  new LinearError(
    `Entity not found: ${entity}`,
    "INPUT_ERROR",
    "invalid input",
    `Could not find referenced ${entity}.`,
  );

/** The value Linear has for a field the fake doesn't keep: nothing, an empty list, zero. */
function emptyValue(type: GraphQLOutputType, where: string): unknown {
  if (!isNonNullType(type)) return null;
  const inner = type.ofType;
  if (isListType(inner)) return [];
  if (isScalarType(inner)) {
    switch (inner.name) {
      case "Int":
      case "Float":
        return 0;
      case "Boolean":
        return false;
      case "JSON":
      case "JSONObject":
        return {};
      case "DateTime":
        return new Date(0).toISOString();
      case "TimelessDate":
        return "1970-01-01";
      default:
        return "";
    }
  }
  if (isObjectType(inner) && inner.name.endsWith("Connection")) return connection([], {});
  // An object Linear always has and the fake doesn't: say so, instead of inventing one.
  throw new GraphQLError(`The fake has no ${where}`);
}

/**
 * Fields are read from the source objects the models build: a value as it is, a function called
 * with the field's arguments. A field the model leaves out gets Linear's empty value for it.
 */
/**
 * The test session an object of the answer belongs to. An object that is part of the answer puts
 * its session on the call's record; one that was only looked at (filtered out of a list) doesn't.
 */
export const OWNER = Symbol("owner");

const fieldResolver: GraphQLFieldResolver<Record<string, unknown>, unknown> = (source, args, context, info) => {
  const owner = (source as { [OWNER]?: string | undefined } | undefined)?.[OWNER];
  if (owner !== undefined) (context as { sessions?: Set<string> }).sessions?.add(owner);
  const value = source?.[info.fieldName];
  if (typeof value === "function") return (value as (args: unknown, context: unknown) => unknown)(args, context);
  if (value !== undefined) return value;
  return emptyValue(info.returnType, `${info.parentType.name}.${info.fieldName}`);
};

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown> | undefined;
  operationName?: string | undefined;
}

/** Parse, validate and run one operation against Linear's schema. */
export async function runGraphQL(
  request: GraphQLRequest,
  root: { Query: Record<string, unknown>; Mutation: Record<string, unknown> },
  context: unknown,
): Promise<{ document: DocumentNode | undefined; result: ExecutionResult }> {
  const schema = linearSchema();
  let document: DocumentNode;
  try {
    document = parse(request.query);
  } catch (error) {
    return { document: undefined, result: { errors: [error as GraphQLError] } };
  }
  const problems = validate(schema, document, [...specifiedRules, maxDepth]);
  if (problems.length > 0) return { document, result: { errors: problems } };
  const isMutation = document.definitions.some(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation === "mutation" &&
      (request.operationName === undefined || definition.name?.value === request.operationName),
  );
  const result = await execute({
    schema,
    document,
    rootValue: isMutation ? root.Mutation : root.Query,
    contextValue: context,
    variableValues: request.variables,
    operationName: request.operationName,
    fieldResolver,
  });
  return { document, result };
}

/** The names of the root fields an operation asks for: what a call is on record as (`agentActivityCreate`). */
export function rootFields(document: DocumentNode | undefined, operationName: string | undefined): string[] {
  const operation = document?.definitions.find(
    (definition) =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      (operationName === undefined || definition.name?.value === operationName),
  );
  if (operation?.kind !== Kind.OPERATION_DEFINITION) return [];
  return operation.selectionSet.selections.flatMap((selection) =>
    selection.kind === Kind.FIELD ? [selection.name.value] : [],
  );
}

interface Paging {
  first?: number | null;
  last?: number | null;
  after?: string | null;
  before?: string | null;
}

/** A Relay connection over a list, paged as Linear pages: `first`/`after`, `last`/`before`, 50 by default. */
export function connection<T extends { id: string }>(items: readonly T[], paging: Paging): Record<string, unknown> {
  let list = [...items];
  // A cursor names an item of the list; one that doesn't (it was deleted, or never was) is refused, so a client never pages from the start again.
  const at = (cursor: string | null | undefined) => {
    if (!cursor) return -1;
    const index = list.findIndex((item) => item.id === cursor);
    if (index === -1) throw new LinearError("Invalid cursor", "INPUT_ERROR", "invalid input");
    return index;
  };
  const start = at(paging.after) + 1;
  const end = paging.before ? Math.max(at(paging.before), 0) : list.length;
  const window = list.slice(start, end);
  list = paging.last ? window.slice(-paging.last) : window.slice(0, paging.first ?? 50);
  const [first, last] = [list[0], list.at(-1)];
  return {
    nodes: list,
    edges: list.map((node) => ({ node, cursor: node.id })),
    pageInfo: {
      hasPreviousPage: start > 0 || (paging.last !== undefined && paging.last !== null && window.length > list.length),
      hasNextPage: end < items.length || ((paging.last ?? null) === null && window.length > list.length),
      startCursor: first?.id ?? null,
      endCursor: last?.id ?? null,
    },
  };
}

type Comparator = Record<string, unknown>;

/** Read a field of a model as GraphQL would: a function is called. */
function read(model: Record<string, unknown>, field: string): unknown {
  const value = model[field];
  return typeof value === "function" ? (value as (args: unknown) => unknown)({}) : value;
}

/** Does one value pass one of Linear's comparators (`{ eq }`, `{ in }`, `{ eqIgnoreCase }`, `{ null }`)? */
function compare(value: unknown, comparator: Comparator): boolean {
  return Object.entries(comparator).every(([operator, expected]) => {
    const text = typeof value === "string" ? value.toLowerCase() : value;
    switch (operator) {
      case "eq":
        return value === expected;
      case "neq":
        return value !== expected;
      case "in":
        return Array.isArray(expected) && expected.includes(value);
      case "nin":
        return Array.isArray(expected) && !expected.includes(value);
      case "eqIgnoreCase":
        return typeof expected === "string" && text === expected.toLowerCase();
      case "containsIgnoreCase":
        return typeof expected === "string" && typeof text === "string" && text.includes(expected.toLowerCase());
      case "null":
        return (value === null || value === undefined) === expected;
      default:
        throw new LinearError(`The fake doesn't filter with "${operator}"`);
    }
  });
}

/**
 * Does a model pass a Linear filter? A field's comparator applies to its value; a filter on a
 * relation (`team: { id: { eq } }`) to the related model; `and` and `or` combine filters.
 */
export function matchesFilter(
  model: Record<string, unknown>,
  filter: Record<string, unknown> | null | undefined,
): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([field, condition]) => {
    if (field === "and")
      return (condition as Array<Record<string, unknown>>).every((inner) => matchesFilter(model, inner));
    if (field === "or")
      return (condition as Array<Record<string, unknown>>).some((inner) => matchesFilter(model, inner));
    const value = read(model, field);
    const cond = condition as Comparator;
    const isComparator = Object.keys(cond).some((key) =>
      ["eq", "neq", "in", "nin", "eqIgnoreCase", "containsIgnoreCase", "null"].includes(key),
    );
    if (isComparator) return compare(value, cond);
    if (value && typeof value === "object") {
      // A relation's list (`labels: { some: … }`) or the related model itself.
      const nodes = (value as { nodes?: unknown }).nodes;
      if (Array.isArray(nodes)) {
        const inner = (cond.some ?? cond.every) as Record<string, unknown>;
        const test = (node: unknown) => matchesFilter(node as Record<string, unknown>, inner);
        return cond.every ? nodes.every(test) : nodes.some(test);
      }
      return matchesFilter(value as Record<string, unknown>, cond);
    }
    return false;
  });
}
