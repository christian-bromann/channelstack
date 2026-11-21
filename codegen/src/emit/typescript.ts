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
      case "ref":
        return side === "wire" ? "string" : type.resources.join(" | ");
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
          resource.scope === "session" ? `{ transport: ctx.transport, session: ${expr}.${resource.idField} }` : "ctx";
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
      default:
        throw new Error(`Can't decode handles inside a ${type.kind}`);
    }
  };

  /** An expression that turns an argument into what goes on the wire: handles become their ids. */
  const encode = (param: IrParam, expr: string): string => {
    const access = param.optional ? "?." : ".";
    if (param.type.kind === "ref") return `${expr}${access}${index.refIdField(param.type.resources)}`;
    if (param.type.kind === "array" && param.type.items.kind === "ref") {
      return `${expr}${access}map((item) => item.${index.refIdField(param.type.items.resources)})`;
    }
    return expr;
  };

  const method = (resource: IrResource, m: IrMethod): string[] => {
    const optionsOptional = m.options.every((option) => option.optional);
    const parameters = [
      ...m.args.map((arg) => `${arg.name}: ${typeOf(arg.type, "public")}`),
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
      ...fields(resource.fields, "public").map((f) => `  readonly ${f};`),
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
            ...resource.fields.map((field) => `    this.${field.name} = ${decode(field.type, `data.${field.name}`)};`),
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
