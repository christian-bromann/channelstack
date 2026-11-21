import type { Ir, IrField, IrMethod, IrParam, IrResource, IrType } from "../ir.ts";
import { BANNER, errorClassName, IrIndex, pathParts } from "./shared.ts";

const OUT = "sdks/typescript/generated/index.ts";

/** The TypeScript SDK's generated half: one file of handle classes, data types and typed errors. */
export function emitTypeScript(ir: Ir): Map<string, string> {
  const index = new IrIndex(ir);

  /** A type as SDK users see it (handles), or as it is on the wire (handle data, ids). */
  const typeOf = (type: IrType, side: "public" | "wire"): string => {
    switch (type.kind) {
      case "string":
      case "boolean":
      case "unknown":
        return type.kind;
      case "number":
      case "integer":
        return "number";
      case "literal":
        return JSON.stringify(type.value);
      case "enum":
        return type.values.map((value) => JSON.stringify(value)).join(" | ");
      case "array": {
        const items = typeOf(type.items, side);
        return items.includes(" ") ? `Array<${items}>` : `${items}[]`;
      }
      case "record":
        return `Record<string, ${typeOf(type.values, side)}>`;
      case "object":
        return `{ ${fields(type.fields, side).join("; ")} }`;
      case "named":
        return side === "wire" && index.holdsResources(type) ? `${type.name}Wire` : type.name;
      case "resource":
        return side === "wire" ? `${type.name}Data` : type.name;
      case "ref": {
        if (side === "public") return type.resources.join(" | ");
        const ids = index.refIdFields(type.resources);
        return ids.length === 1 ? "string" : `{ ${ids.map((id) => `${id}: string`).join("; ")} }`;
      }
      case "union":
        return type.types.map((member) => typeOf(member, side)).join(" | ");
    }
  };

  const fields = (list: readonly IrField[], side: "public" | "wire") =>
    list.map((field) => `${field.name}${field.optional ? "?" : ""}: ${typeOf(field.type, side)}`);

  /** An expression that turns wire data into what SDK users see. */
  const decode = (type: IrType, expr: string): string => {
    if (!index.holdsResources(type)) return expr;
    switch (type.kind) {
      case "resource": {
        const resource = index.resource(type.name);
        const context =
          resource.scope === "session"
            ? `{ transport: ctx.transport, session: ${expr}.${resource.idFields?.[0]} }`
            : "ctx";
        return `new ${type.name}(${context}, ${expr})`;
      }
      case "array":
        return `${expr}.map((item) => ${decode(type.items, "item")})`;
      case "named":
        return `decode${type.name}(ctx, ${expr})`;
      case "object":
        return `{ ...${expr}, ${type.fields
          .filter((field) => index.holdsResources(field.type))
          .map((field) => `${field.name}: ${decode(field.type, `${expr}.${field.name}`)}`)
          .join(", ")} }`;
      case "union": {
        // Handle data in a union is told apart by its discriminator field, e.g. `kind: "user" | "app"`.
        const members = index.discriminated(type);
        if (!members)
          throw new Error("A union that holds handles needs a discriminator every member declares as a literal");
        return members
          .map(({ value, member }, position) =>
            position === members.length - 1
              ? decode(member, expr)
              : `${expr}.${type.discriminator} === ${JSON.stringify(value)} ? ${decode(member, expr)} : `,
          )
          .join("");
      }
      default:
        throw new Error(`Can't decode handles inside a ${type.kind}`);
    }
  };

  /** Does a value of this type carry handles that have to be sent as ids? */
  const holdsRefs = (type: IrType): boolean =>
    type.kind === "ref" ||
    (type.kind === "array" && holdsRefs(type.items)) ||
    (type.kind === "object" && type.fields.some((field) => holdsRefs(field.type)));

  /** An expression that turns a value into what goes on the wire: handles become their ids. */
  const encodeValue = (type: IrType, expr: string): string => {
    if (!holdsRefs(type)) return expr;
    if (type.kind === "ref") {
      const ids = index.refIdFields(type.resources);
      return ids.length === 1 ? `${expr}.${ids[0]}` : `{ ${ids.map((id) => `${id}: ${expr}.${id}`).join(", ")} }`;
    }
    if (type.kind === "array") return `${expr}.map((item) => ${encodeValue(type.items, "item")})`;
    if (type.kind === "object") {
      const converted = type.fields
        .filter((field) => holdsRefs(field.type))
        .map((field) => `${field.name}: ${encodeField(field, `${expr}.${field.name}`)}`);
      return `{ ...${expr}, ${converted.join(", ")} }`;
    }
    return expr;
  };

  const encodeField = (field: IrField, expr: string): string =>
    field.optional && holdsRefs(field.type)
      ? `${expr} === undefined ? undefined : ${encodeValue(field.type, expr)}`
      : encodeValue(field.type, expr);

  /** An argument or option as it goes on the wire. A string where an object is expected is its shorthand. */
  const encode = (param: IrParam, expr: string): string =>
    param.shorthand === undefined
      ? encodeField(param, expr)
      : `typeof ${expr} === "string" ? { ${param.shorthand}: ${expr} } : ${encodeField(param, expr)}`;

  const parameterType = (param: IrParam): string =>
    `${param.shorthand === undefined ? "" : "string | "}${typeOf(param.type, "public")}`;

  const method = (resource: IrResource, m: IrMethod): string[] => {
    const optionsOptional = m.options.every((option) => option.optional);
    const parameters = [
      ...m.args.map((arg) => `${arg.name}: ${parameterType(arg)}`),
      ...(m.options.length > 0
        ? [`options: { ${fields(m.options, "public").join("; ")} }${optionsOptional ? " = {}" : ""}`]
        : []),
    ];
    const path = pathParts(m)
      .map((part) => {
        if (typeof part === "string") return part;
        return part.from === "session" ? `\${segment(sessionOf(ctx))}` : `\${segment(this.${part.field})}`;
      })
      .join("");
    const value = (param: IrParam) => encode(param, m.args.includes(param) ? param.name : `options.${param.name}`);
    const entry = (param: IrParam) => (value(param) === param.name ? param.name : `${param.name}: ${value(param)}`);
    const params = [...m.args, ...m.options];
    const body = params.filter((param) => param.in === "body");
    const query = params.filter((param) => param.in === "query");
    const request = [
      ...(body.length > 0 ? [`body: { ${body.map(entry).join(", ")} }`] : []),
      ...(query.length > 0 ? [`query: { ${query.map(entry).join(", ")} }`] : []),
    ];
    const call = `ctx.transport.request(${JSON.stringify(m.http.verb)}, \`${path}\`${request.length > 0 ? `, { ${request.join(", ")} }` : ""})`;
    const returns = m.returns ? typeOf(m.returns, "public") : "void";
    return [
      "",
      `  /** ${m.summary}.${m.stability === "experimental" ? " Experimental." : ""} */`,
      `  async ${m.name}(${parameters.join(", ")}): Promise<${returns}> {`,
      "    const ctx = this.#ctx;",
      ...(m.returns
        ? [
            `    const data = (await ${call}) as ${typeOf(m.returns, "wire")};`,
            `    return ${decode(m.returns, "data")};`,
          ]
        : [`    await ${call};`]),
      "  }",
      ...(m.dispose && resource.name !== ir.root
        ? [
            "",
            "  async [Symbol.asyncDispose](): Promise<void> {",
            `    await disposeQuietly(() => this.${m.name}());`,
            "  }",
          ]
        : []),
    ];
  };

  const resourceClass = (resource: IrResource): string[] => {
    const isRoot = resource.name === ir.root;
    const disposable = !isRoot && index.disposer(resource) !== undefined;
    return [
      ...(isRoot
        ? []
        : [
            `/** Wire data of a {@link ${resource.name}}. */`,
            `export interface ${resource.name}Data {`,
            ...fields(resource.fields, "wire").map((f) => `  ${f};`),
            "}",
            "",
          ]),
      `export class ${resource.name}${isRoot ? " extends ClientBase" : disposable ? " implements AsyncDisposable" : ""} {`,
      // An optional field is always present on a handle, as undefined when the server didn't send it.
      ...resource.fields.map(
        (field) => `  readonly ${field.name}: ${typeOf(field.type, "public")}${field.optional ? " | undefined" : ""};`,
      ),
      "  readonly #ctx: HandleContext;",
      "",
      "  /** @internal Handles come from the SDK, never from `new`. */",
      ...(isRoot
        ? [
            "  constructor(transport: Transport, stop: () => Promise<void>) {",
            "    super(stop);",
            "    this.#ctx = { transport, session: undefined };",
          ]
        : [
            `  constructor(ctx: HandleContext, data: ${resource.name}Data) {`,
            "    this.#ctx = ctx;",
            ...resource.fields.map((field) => {
              const value = decode(field.type, `data.${field.name}`);
              const guarded =
                field.optional && value !== `data.${field.name}`
                  ? `data.${field.name} === undefined ? undefined : ${value}`
                  : value;
              return `    this.${field.name} = ${guarded};`;
            }),
          ]),
      "  }",
      ...resource.methods.flatMap((m) => method(resource, m)),
      "}",
      "",
    ];
  };

  const dataType = ({ name, type }: Ir["types"][number]): string[] => {
    const declare = (suffix: string, side: "public" | "wire") =>
      type.kind === "object"
        ? [`export interface ${name}${suffix} {`, ...fields(type.fields, side).map((f) => `  ${f};`), "}", ""]
        : [`export type ${name}${suffix} = ${typeOf(type, side)};`, ""];
    if (!index.holdsResources(type)) return declare("", "public");
    return [
      ...declare("", "public"),
      ...declare("Wire", "wire"),
      `function decode${name}(ctx: HandleContext, data: ${name}Wire): ${name} {`,
      `  return ${decode(type, "data")};`,
      "}",
      "",
    ];
  };

  const disposes = ir.resources.some((resource) => resource.name !== ir.root && index.disposer(resource) !== undefined);
  const usesSession = ir.resources.some((resource) =>
    resource.methods.some((m) => m.http.pathParams.some((p) => p.from === "session")),
  );
  const lines = [
    `// ${BANNER}`,
    `import { ClientBase, connectWith${disposes ? ", disposeQuietly" : ""}, type HandleContext${usesSession ? ", sessionOf" : ""} } from "../runtime/client.ts";`,
    'import type { LaunchOptions } from "../runtime/launcher.ts";',
    'import { ChannelstackError, type ErrorClasses, segment, type Transport } from "../runtime/transport.ts";',
    "",
    "/** The server version this SDK was generated for. */",
    `export const VERSION = ${JSON.stringify(ir.version)};`,
    "",
    ...ir.errors.flatMap((code) => [`export class ${errorClassName(code)} extends ChannelstackError {}`]),
    "",
    "const ERRORS: ErrorClasses = {",
    ...ir.errors.map((code) => `  ${code}: ${errorClassName(code)},`),
    "};",
    "",
    ...ir.types.flatMap(dataType),
    ...ir.resources.flatMap(resourceClass),
    "/** Attach to a running channelstack server, or start one, and return the client. */",
    `export function connect(options: LaunchOptions = {}): Promise<${ir.root}> {`,
    "  return connectWith(",
    `    (transport, stop) => new ${ir.root}(transport, stop),`,
    `    { basePath: ${JSON.stringify(ir.basePath)}, errors: ERRORS, version: VERSION },`,
    "    options,",
    "  );",
    "}",
    "",
  ];
  return new Map([[OUT, lines.join("\n")]]);
}
