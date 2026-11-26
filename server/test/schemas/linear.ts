import {
  type FieldNode,
  type FragmentDefinitionNode,
  getNamedType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  isAbstractType,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionSetNode,
  validate,
} from "graphql";

import { linearSchema } from "../../src/drivers/linear/fake/graphql.ts";

/**
 * Linear's committed schema as a check, independent of the fake's own execution: a GraphQL answer
 * is walked along the operation it answers, and a webhook payload along the `…WebhookPayload` type
 * it is. Exit check 4.3 holds every answer and every delivery to it.
 */

/** What is wrong with one scalar or enum value, or nothing. */
function scalarProblem(type: GraphQLNamedType, value: unknown): string | undefined {
  if (isEnumType(type))
    return type.getValues().some((entry) => entry.value === value) ? undefined : `is not one of ${type.name}'s values`;
  switch (type.name) {
    case "String":
    case "ID":
      return typeof value === "string" ? undefined : "must be a string";
    case "Int":
      return Number.isInteger(value) ? undefined : "must be an integer";
    case "Float":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "must be a number";
    case "Boolean":
      return typeof value === "boolean" ? undefined : "must be a boolean";
    case "DateTime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? undefined : "must be an ISO date-time";
    case "TimelessDate":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? undefined : "must be a date";
    case "JSONObject":
      // Linear's JSONObject is any embedded JSON; `reactionData`, typed as one, is a list in every payload.
      return typeof value === "object" && value !== null ? undefined : "must be JSON";
    default:
      return undefined;
  }
}

type Checker = (
  object: GraphQLObjectType,
  value: Record<string, unknown>,
) => Array<{ key: string; type: GraphQLOutputType; checker: Checker }>;

/** Check a value of a type, then each field of an object that `checker` names. */
function check(
  type: GraphQLOutputType,
  value: unknown,
  path: string,
  checker: Checker,
  strict: boolean,
  problems: string[],
): void {
  if (value === null || value === undefined) {
    if (isNonNullType(type))
      problems.push(`${path} is ${value === null ? "null" : "missing"}, but the schema says ${String(type)}`);
    return;
  }
  const inner = isNonNullType(type) ? type.ofType : type;
  if (isListType(inner)) {
    if (!Array.isArray(value)) return void problems.push(`${path} must be a list (${String(inner)})`);
    for (const [index, item] of value.entries())
      check(inner.ofType as GraphQLOutputType, item, `${path}[${index}]`, checker, strict, problems);
    return;
  }
  const named = getNamedType(inner);
  if (isScalarType(named) || isEnumType(named)) {
    const problem = scalarProblem(named, value);
    if (problem) problems.push(`${path} ${problem} (${named.name}), got ${JSON.stringify(value)?.slice(0, 60)}`);
    return;
  }
  if (typeof value !== "object" || Array.isArray(value))
    return void problems.push(`${path} must be an object (${named.name})`);
  const object = value as Record<string, unknown>;
  let concrete: GraphQLObjectType | undefined = isObjectType(named) ? named : undefined;
  if (isAbstractType(named)) {
    // An abstract type is told apart by `__typename`.
    // An answer names it in `__typename`; a webhook doesn't, so there it is the one member the value fits.
    const found = typeof object.__typename === "string" ? linearSchema().getType(object.__typename) : undefined;
    concrete = found && isObjectType(found) && linearSchema().isSubType(named, found) ? found : undefined;
    if (!concrete && object.__typename === undefined && strict) {
      concrete = linearSchema()
        .getPossibleTypes(named)
        .find((member) => {
          const trial: string[] = [];
          check(member, value, path, checker, strict, trial);
          return trial.length === 0;
        });
    }
    if (!concrete)
      return void problems.push(`${path} is a ${named.name} without a __typename that names one of its types`);
  }
  if (!concrete) return;
  const known = concrete.getFields();
  if (strict)
    for (const key of Object.keys(object))
      if (!(key in known) && key !== "__typename") problems.push(`${path}.${key} isn't a field of ${concrete.name}`);
  for (const field of checker(concrete, object))
    check(field.type, object[field.key], `${path}.${field.key}`, field.checker, strict, problems);
}

/** Every field of a type, all the way down: how a webhook payload is checked. */
const everything: Checker = (object) =>
  Object.entries(object.getFields()).map(([key, field]) => ({ key, type: field.type, checker: everything }));

/**
 * What is wrong with a GraphQL answer, by Linear's schema: nothing (`[]`), or one line per
 * problem. The operation must be one the schema accepts, and the answer has to be what it asks for.
 */
export function linearResponseProblems(
  request: { query: string; variables?: Record<string, unknown>; operationName?: string },
  status: number,
  body: unknown,
): string[] {
  const schema = linearSchema();
  const answer = body as { data?: Record<string, unknown> | null; errors?: Array<{ message?: unknown }> } | undefined;
  const hasErrors =
    Array.isArray(answer?.errors) &&
    answer.errors.length > 0 &&
    answer.errors.every((error) => typeof error.message === "string");
  // A refused request (no token, a query that doesn't parse) answers with GraphQL's errors.
  if (status !== 200) return hasErrors ? [] : [`a ${status} answer needs GraphQL errors with a message`];
  const document = parse(request.query);
  const invalid = validate(schema, document);
  if (invalid.length > 0) return invalid.map((error) => `the operation isn't valid: ${error.message}`);
  const operation = document.definitions.find(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      (request.operationName === undefined || definition.name?.value === request.operationName),
  );
  const root = operation?.operation === "mutation" ? schema.getMutationType() : schema.getQueryType();
  if (!operation || !root) return ["no operation to check the answer against"];
  if (answer?.data === null || answer?.data === undefined)
    return hasErrors ? [] : ["an answer without data needs errors"];
  const fragments = new Map(
    document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((fragment) => [fragment.name.value, fragment]),
  );
  /** The fields a selection asks of an object of this type, fragments spread out. */
  const fieldsOf = (set: SelectionSetNode | undefined, type: GraphQLObjectType): FieldNode[] =>
    (set?.selections ?? []).flatMap((selection) => {
      if (selection.kind === Kind.FIELD) return [selection];
      const fragment = selection.kind === Kind.INLINE_FRAGMENT ? selection : fragments.get(selection.name.value);
      const condition = fragment?.typeCondition?.name.value;
      const target = condition === undefined ? undefined : schema.getType(condition);
      const applies =
        condition === undefined ||
        condition === type.name ||
        (target !== undefined && isAbstractType(target) && schema.isSubType(target, type));
      return applies ? fieldsOf(fragment?.selectionSet, type) : [];
    });
  /** What a selection asks of an object, each field with what is asked of it in turn. */
  const asked =
    (selection: SelectionSetNode | undefined): Checker =>
    (object) =>
      fieldsOf(selection, object).flatMap((field) => {
        const definition = object.getFields()[field.name.value];
        if (!definition) return [];
        return [
          { key: field.alias?.value ?? field.name.value, type: definition.type, checker: asked(field.selectionSet) },
        ];
      });
  const problems: string[] = [];
  for (const field of fieldsOf(operation.selectionSet, root)) {
    const definition = root.getFields()[field.name.value];
    if (!definition) continue;
    const key = field.alias?.value ?? field.name.value;
    // A root field whose resolver failed is null, with an error naming it.
    if (answer.data[key] === null && hasErrors) continue;
    check(definition.type, answer.data[key], key, asked(field.selectionSet), false, problems);
  }
  return problems;
}

/** What is wrong with a webhook payload, by the `…WebhookPayload` type of Linear's schema it is. */
export function linearWebhookProblems(type: string, payload: unknown): string[] {
  const schema = linearSchema();
  const typeOf = (name: string) => {
    const found = schema.getType(name);
    return found && isObjectType(found) ? found : undefined;
  };
  const problems: string[] = [];
  if (type === "AgentSessionEvent") {
    const envelope = typeOf("AgentSessionEventWebhookPayload");
    if (!envelope) return ["Linear's schema has no AgentSessionEventWebhookPayload"];
    check(envelope, payload, "payload", everything, true, problems);
    return problems;
  }
  // An entity event's `data` is its resource's payload type: `Issue` → `IssueWebhookPayload`.
  const [envelope, data] = [typeOf("EntityWebhookPayload"), typeOf(`${type}WebhookPayload`)];
  if (!envelope || !data) return [`Linear's schema has no payload type for ${type} events`];
  const { data: value, ...rest } = payload as Record<string, unknown>;
  const withoutData: Checker = (object, record) => everything(object, record).filter((field) => field.key !== "data");
  check(envelope, rest, "payload", withoutData, true, problems);
  check(data, value, "payload.data", everything, true, problems);
  return problems;
}
