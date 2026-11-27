import type { Ir, IrField, IrMethod, IrParam, IrResource, IrType, IrWait } from "../ir.ts";
import { channelGlue } from "./channels.ts";
import { BANNER, errorClassName, IrIndex, pathParts } from "./shared.ts";

const OUT = "sdks/typescript/generated/index.ts";
const CHANNELS_OUT = "sdks/typescript/generated/channels.ts";

/** What the SDK and the Vitest integration need per channel, from the IR: the channel list, the fixtures, the unions. */
function channelsFile(ir: Ir): string {
  const glue = channelGlue(ir);
  const union = (names: readonly string[]) =>
    names.length === 0 ? "never" : names.map((name) => `G.${name}`).join(" | ");
  const inspectable = glue.deliveries.reduceRight(
    (rest, delivery) => `TDelivery extends G.${delivery} ? G.${delivery.replace(/Delivery$/, "Fixture")} : ${rest}`,
    "never",
  );
  return [
    `// ${BANNER}`,
    'import type * as G from "./index.ts";',
    "",
    "type Option<Method extends (...args: never[]) => unknown> = NonNullable<Parameters<Method>[0]>;",
    "",
    "/** Every channel, by name, in the server's order. */",
    `export const CHANNEL_NAMES = [${glue.channels.map((channel) => JSON.stringify(channel.name)).join(", ")}] as const;`,
    "export type ChannelKind = (typeof CHANNEL_NAMES)[number];",
    "/** Each channel's fixture, by its name: what a test framework hands a test. */",
    "export interface ChannelFixtures {",
    ...glue.channels.map((channel) => `  ${channel.name}: G.${channel.title}Fixture;`),
    "}",
    "/** The fakes the agent calls that aren't channels (the fake OpenAI), by name. */",
    `export const PROVIDER_NAMES = [${glue.providers.map((provider) => JSON.stringify(provider.name)).join(", ")}] as const;`,
    "export type ProviderKind = (typeof PROVIDER_NAMES)[number];",
    "/** Each provider's fixture, by its name: what a test framework hands a test besides the channels. */",
    "export interface ProviderFixtures {",
    ...glue.providers.map((provider) => `  ${provider.name}: G.${provider.title}Fixture;`),
    "}",
    `export type User = ${union(glue.users)};`,
    `export type App = ${union(glue.apps)};`,
    `export type Resource = ${union(glue.resources)};`,
    `export type AnyDelivery = ${union(glue.deliveries)};`,
    `export type DeliveryFilter = ${glue.filteredDeliveries.map((name) => `Option<G.${name}["deliveries"]>`).join(" | ") || "never"};`,
    `export type ApiCall = ${union(glue.apiCalls)};`,
    `export type Transcript = ${union(glue.transcripts)};`,
    "/** What every channel fixture has to inspect what the agent did: the fixture whose deliveries are `TDelivery`. */",
    `export type Inspectable<TDelivery extends AnyDelivery = AnyDelivery> = ${inspectable};`,
    "",
  ].join("\n");
}

/**
 * How the TypeScript SDK spells types: as its users see them (`public`: handles, `Duration`) or as
 * they are on the wire (ids, milliseconds). The docs show the public side.
 */
export function typeScriptTypes(index: IrIndex) {
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
      case "duration":
        return side === "wire" ? "number" : "Duration";
      case "literal":
        return JSON.stringify(type.value);
      case "enum":
        return type.values.map((value) => JSON.stringify(value)).join(" | ");
      case "array": {
        const items = typeOf(type.items, side);
        const list = items.includes(" ") ? `Array<${items}>` : `${items}[]`;
        return type.oneOrMany && side === "public" ? `${items} | ${list}` : list;
      }
      case "record":
        return `Record<string, ${typeOf(type.values, side)}>`;
      case "object": {
        const whole = `{ ${fields(type.fields, side).join("; ")} }`;
        const short = side === "public" ? type.fields.find((field) => field.name === type.shorthand) : undefined;
        return short ? `${typeOf(short.type, side)} | ${whole}` : whole;
      }
      case "files":
        if (type.mode === "document")
          return side === "public" ? "string | { path: string } | unknown[]" : "string | unknown[]";
        if (side === "public")
          return type.mode === "tree" ? "string | FileInput[]" : "FileInput[] | Record<string, string | null>";
        return `Array<{ path: string; content: string${type.mode === "changes" ? " | null" : ""} }>`;
      case "pattern":
        return side === "public" ? "string | RegExp" : "string | { source: string; flags: string }";
      case "named":
        return side === "wire" && index.holdsResources(type) ? `${type.name}Wire` : type.name;
      case "resource":
        return side === "wire" ? `${type.name}Data` : type.name;
      case "ref": {
        if (side === "public") return type.resources.join(" | ");
        const ids = index.refIds(type.resources);
        const [only] = ids;
        return ids.length === 1 && only ? typeOf(only.type, side) : `{ ${fields(ids, side).join("; ")} }`;
      }
      case "nullable":
        return `${typeOf(type.type, side)} | ${side === "wire" ? "null" : "undefined"}`;
      case "union":
        return type.types.map((member) => typeOf(member, side)).join(" | ");
    }
  };

  const fields = (list: readonly IrField[], side: "public" | "wire") =>
    list.map((field) => `${field.name}${field.optional ? "?" : ""}: ${typeOf(field.type, side)}`);

  return { typeOf, fields };
}

/** The TypeScript SDK's generated half: one file of handle classes, data types and typed errors. */
export function emitTypeScript(ir: Ir): Map<string, string> {
  const index = new IrIndex(ir);
  const { typeOf, fields } = typeScriptTypes(index);

  /** An expression as the body of an arrow function: an object literal needs parentheses there. */
  const returned = (expr: string): string => (expr.startsWith("{") ? `(${expr})` : expr);

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
        return `${expr}.map((item) => ${returned(decode(type.items, "item"))})`;
      case "named":
        return `decode${type.name}(ctx, ${expr})`;
      case "nullable":
        return `(${expr} === null ? undefined : ${decode(type.type, expr)})`;
      case "record":
        return `Object.fromEntries(Object.entries(${expr}).map(([key, value]) => [key, ${decode(type.values, "value")}]))`;
      case "object": {
        const converted = type.fields.filter((field) => index.holdsResources(field.type));
        const optional = converted.filter((field) => field.optional);
        // An optional field is taken out first, so one the server left out stays left out (and keeps its type).
        const source = optional.length > 0 ? "rest" : expr;
        const entries = converted.map((field) =>
          field.optional
            ? `...(${field.name} === undefined ? {} : { ${field.name}: ${decode(field.type, field.name)} })`
            : `${field.name}: ${decode(field.type, `${source}.${field.name}`)}`,
        );
        const built = `{ ...${source}, ${entries.join(", ")} }`;
        return optional.length > 0
          ? `(({ ${optional.map((field) => field.name).join(", ")}, ...rest }: typeof ${expr}) => (${built}))(${expr})`
          : built;
      }
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
    type.kind === "duration" ||
    type.kind === "files" ||
    type.kind === "pattern" ||
    (type.kind === "object" && type.shorthand !== undefined) ||
    (type.kind === "array" && type.oneOrMany === true) ||
    (type.kind === "array" && holdsRefs(type.items)) ||
    (type.kind === "object" && type.fields.some((field) => holdsRefs(field.type)));

  /** An expression that turns a value into what goes on the wire: handles become their ids. */
  const encodeValue = (type: IrType, expr: string): string => {
    if (!holdsRefs(type)) return expr;
    if (type.kind === "ref") {
      const ids = index.refIdFields(type.resources);
      return ids.length === 1 ? `${expr}.${ids[0]}` : `{ ${ids.map((id) => `${id}: ${expr}.${id}`).join(", ")} }`;
    }
    if (type.kind === "duration") return `parseDuration(${expr})`;
    if (type.kind === "files")
      return `${{ tree: "readTree", changes: "readChanges", document: "readDocument" }[type.mode]}(${expr})`;
    if (type.kind === "pattern") return `patternOnWire(${expr})`;
    if (type.kind === "array") {
      const list = type.oneOrMany ? `[${expr}].flat()` : expr;
      const item = encodeValue(type.items, "item");
      return item === "item" ? list : `${list}.map((item) => ${returned(item)})`;
    }
    if (type.kind === "object") {
      const converted = type.fields
        .filter((field) => holdsRefs(field.type))
        .map((field) => `${field.name}: ${encodeField(field, `${expr}.${field.name}`)}`);
      const whole = converted.length > 0 ? `{ ...${expr}, ${converted.join(", ")} }` : expr;
      const short = type.fields.find((field) => field.name === type.shorthand);
      if (!short) return whole;
      // The value of one field stands for the whole object: a handle, or a plain string.
      const given =
        short.type.kind === "ref"
          ? short.type.resources.map((name) => `${expr} instanceof ${name}`).join(" || ")
          : `typeof ${expr} === "string"`;
      return `(${given} ? { ${short.name}: ${encodeValue(short.type, expr)} } : ${whole})`;
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
    const { responder } = m;
    // A responder's flag is the SDK's to set: the caller passes a function instead.
    const shown = responder ? m.options.filter((option) => option.name !== responder.flag) : m.options;
    const optionsOptional = shown.every((option) => option.optional);
    // An optional argument before options that must be given is one that may be `undefined`.
    const optionalArg = (arg: IrParam) => (!arg.optional ? "" : shown.length > 0 && !optionsOptional ? "" : "?");
    const [first] = m.args;
    /** What a responder returns: one item of the argument's list. */
    const responderType =
      responder && first
        ? `Responder<${responder.request}, ${typeOf(first.type.kind === "array" ? first.type.items : first.type, "public")}>`
        : undefined;
    const parameters = [
      ...m.args.map(
        (arg) =>
          `${arg.name}${optionalArg(arg)}: ${parameterType(arg)}${arg === first && responderType ? ` | ${responderType}` : ""}${arg.optional && optionalArg(arg) === "" ? " | undefined" : ""}`,
      ),
      ...(shown.length > 0
        ? [
            `options: { ${shown.map((option) => `${option.name}${option.optional ? "?" : ""}: ${parameterType(option)}`).join("; ")} }${optionsOptional ? " = {}" : ""}`,
          ]
        : []),
    ];
    const path = pathParts(m)
      .map((part) => {
        if (typeof part === "string") return part;
        return part.from === "session" ? `\${segment(sessionOf(ctx))}` : `\${segment(this.${part.field})}`;
      })
      .join("");
    const given = (param: IrParam) => {
      if (responder && param === first) return `(answer === undefined ? (${param.name} as ${parameterType(param)} | undefined) : undefined)`;
      if (responder && param.name === responder.flag) return "answer !== undefined";
      return m.args.includes(param) ? param.name : `options.${param.name}`;
    };
    const value = (param: IrParam) => {
      const sent = encode(param, given(param));
      if (param.credential === undefined) return sent;
      // Left out, it comes from the environment: the same test runs fake on PRs and live nightly.
      const fields = [...param.credential.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
      const values = fields.map((field) => {
        const source = [...m.args, ...m.options].find((candidate) => candidate.name === field);
        return `${field}: ${source ? given(source) : "undefined"}`;
      });
      return `${sent} ?? credential(${JSON.stringify(param.credential)}, { ${values.join(", ")} })`;
    };
    const entry = (param: IrParam) => (value(param) === param.name ? param.name : `${param.name}: ${value(param)}`);
    const params = [...m.args, ...m.options];
    const body = params.filter((param) => param.in === "body");
    const query = params.filter((param) => param.in === "query");
    const request = [
      ...(body.length > 0 ? [`body: { ${body.map(entry).join(", ")} }`] : []),
      ...(query.length > 0 ? [`query: { ${query.map(entry).join(", ")} }`] : []),
    ];
    const sent = `ctx.transport.request(${JSON.stringify(m.http.verb)}, \`${path}\`${request.length > 0 ? `, { ${request.join(", ")} }` : ""})`;
    const call = m.retryWhile ? `retryWhile(${JSON.stringify(m.retryWhile)}, () => ${sent})` : sent;
    const returns = m.returns ? typeOf(m.returns, "public") : "void";
    return [
      "",
      `  /** ${m.summary}.${m.stability === "experimental" ? " Experimental." : ""} */`,
      `  ${index.inherits(resource, m.name) ? "override " : ""}async ${m.name}(${parameters.join(", ")}): Promise<${returns}> {`,
      "    const ctx = this.#ctx;",
      ...(responder && first ? [`    const answer = typeof ${first.name} === "function" ? ${first.name} : undefined;`] : []),
      ...(m.onceQuiet ? ["    await untilQuiet(() => quietOf(ctx));"] : []),
      ...(m.returns && responder
        ? [
            `    const data = (await ${call}) as ${typeOf(m.returns, "wire")};`,
            `    const handle = ${decode(m.returns, "data")};`,
            // The test answers each call the server holds for this script, in the background.
            `    if (answer !== undefined) respondWith({ held: (o) => handle.${responder.held}(o), answer: (id, o) => handle.${responder.answer}(id, o) }, answer);`,
            "    return handle;",
          ]
        : m.returns
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

  /** `thread.waitForReply()`, `thread.latestReply()`: waits generated from a list read. */
  const wait = (resource: IrResource, w: IrWait): string[] => {
    const item = typeOf(w.item, "public");
    const fromField =
      w.item.kind === "resource" ? index.resource(w.item.name).fields.find((f) => f.name === w.from) : undefined;
    const from = fromField ? `from?: ${typeOf(fromField.type, "public")} | string` : undefined;
    const narrowing = [...(from ? [from] : []), ...(w.text ? [`${w.text}?: string | RegExp`] : [])];
    const options = `${narrowing.length > 0 ? `{ ${narrowing.join("; ")} } & ` : ""}${w.mode === "next" ? "WaitOptions" : "QuietOptions"}`;
    const conditions = [
      ...(from ? [`fromMatches(item.${w.from}, options.from)`] : []),
      ...(w.text ? [`textMatches(item.${w.text}, options.${w.text})`] : []),
      ...Object.entries(w.where ?? {}).map(([field, value]) => `item.${field} === ${JSON.stringify(value)}`),
    ];
    const matches = conditions.length > 0 ? `(item) => ${conditions.join(" && ")}` : "() => true";
    const what = from ? `describeWait(${JSON.stringify(w.what)}, options.from)` : JSON.stringify(w.what);
    // With `filter`, the read's own options come first and are passed through to it.
    const read = resource.methods.find((m) => m.name === w.read);
    // Without anything it must be given, the filter may be left out: `openai.latestCall()`.
    const filterDefault = read?.options.every((option) => option.optional) ? " = {}" : "";
    const filter = w.filter && read ? `filter: { ${fields(read.options, "public").join("; ")} }${filterDefault}, ` : "";
    const call = `() => this.${w.read}(${filter === "" ? "" : "filter"})`;
    const noun = w.what.replace(/^an? /, "");
    if (w.mode === "until" && w.in) {
      const fieldType =
        w.field === undefined
          ? item
          : typeOf(
              index.resource((w.item as { name: string }).name).fields.find((f) => f.name === w.field)?.type ?? {
                kind: "unknown",
              },
              "public",
            );
      const value = w.field === undefined ? "value" : `value.${w.field}`;
      return [
        "",
        `  /** Wait for ${w.what}: one of the values given. Resolves with the value as it is then. */`,
        `  async ${w.name}(wanted: ${fieldType} | Array<${fieldType}>, options: WaitOptions = {}): Promise<${item}> {`,
        "    const values: unknown[] = [wanted].flat();",
        `    return waitFor(${JSON.stringify(w.what)}, async () => {`,
        `      const value = await this.${w.read}();`,
        `      return values.includes(${value}) ? value : undefined;`,
        "    }, options);",
        "  }",
      ];
    }
    if (w.mode === "until") {
      const pending = (w.not ?? []).map((value) => `value.${w.field} === ${JSON.stringify(value)}`).join(" || ");
      return [
        "",
        `  /** Wait for ${w.what}, and resolve with the value as it is then. */`,
        `  async ${w.name}(options: WaitOptions = {}): Promise<${item}> {`,
        `    return waitFor(${JSON.stringify(w.what)}, async () => {`,
        `      const value = await this.${w.read}();`,
        `      return ${pending} ? undefined : value;`,
        "    }, options);",
        "  }",
      ];
    }
    return [
      "",
      w.mode === "next"
        ? `  /** Wait for the next new ${noun}${from ? " matching `from` (anyone if omitted)" : ""}, after the last one this handle saw. */`
        : `  /** The latest ${noun}${from ? " matching `from`" : ""}, once the agent is quiet. Waits for at least one. */`,
      `  async ${w.name}(${filter}options: ${options} = {}): Promise<${item}> {`,
      w.mode === "next"
        ? // A filtered read is its own list, so each filter keeps its own place in it.
          `    return waitForNext(this.#seen, ${filter ? `\`${w.name}:\${JSON.stringify(filter)}\`` : JSON.stringify(w.name)}, ${call}, ${matches}, ${what}, options${w.turn ? `, (item) => item.${w.turn.field} === ${JSON.stringify(w.turn.value)}` : ""});`
        : `    return latestOnceQuiet(${call}, ${matches}, () => quietOf(this.#ctx), ${what}, options);`,
      "  }",
    ];
  };

  const resourceClass = (resource: IrResource): string[] => {
    const isRoot = resource.name === ir.root;
    const disposable = !isRoot && index.disposer(resource) !== undefined;
    const waits = resource.waits ?? [];
    const seen = waits.some((w) => w.mode === "next") ? ["  readonly #seen = new Map<string, number>();"] : [];
    const parent = resource.extends;
    const own = index.ownFields(resource);
    const quiet =
      isRoot || parent !== undefined
        ? []
        : [
            "",
            "  /** @internal Is the agent quiet in this handle's session? Matchers ask this. */",
            "  [QUIET](): Promise<QuietState> {",
            "    return quietOf(this.#ctx);",
            "  }",
          ];
    const tail = [
      ...resource.methods.flatMap((m) => method(resource, m)),
      ...waits.flatMap((w) => wait(resource, w)),
      ...quiet,
      "}",
      "",
    ];
    return [
      ...(isRoot
        ? []
        : [
            `/** Wire data of a {@link ${resource.name}}. */`,
            `export interface ${resource.name}Data${parent === undefined ? "" : ` extends ${parent}Data`} {`,
            ...fields(own, "wire").map((f) => `  ${f};`),
            "}",
            "",
          ]),
      `export class ${resource.name}${isRoot ? " extends ClientBase" : parent !== undefined ? ` extends ${parent}` : disposable ? " implements AsyncDisposable" : ""} {`,
      // An optional field is always present on a handle, as undefined when the server didn't send it.
      ...own.map(
        (field) => `  readonly ${field.name}: ${typeOf(field.type, "public")}${field.optional ? " | undefined" : ""};`,
      ),
      "  readonly #ctx: HandleContext;",
      ...seen,
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
            ...(parent === undefined ? [] : ["    super(ctx, data);"]),
            "    this.#ctx = ctx;",
            ...own.map((field) => {
              const value = decode(field.type, `data.${field.name}`);
              const guarded =
                field.optional && value !== `data.${field.name}`
                  ? `data.${field.name} === undefined ? undefined : ${value}`
                  : value;
              return `    this.${field.name} = ${guarded};`;
            }),
          ]),
      "  }",
      ...tail,
    ];
  };
  const dataType = ({ name, type, stringField }: Ir["types"][number]): string[] => {
    // A value with a text form prints as that text: `transcript.toString()`.
    const printable = stringField !== undefined && type.kind === "object";
    const declare = (suffix: string, side: "public" | "wire") =>
      type.kind === "object"
        ? [
            `export interface ${name}${suffix} {`,
            ...fields(type.fields, side).map((f) => `  ${f};`),
            ...(printable && side === "public" ? ["  toString(): string;"] : []),
            "}",
            "",
          ]
        : [`export type ${name}${suffix} = ${typeOf(type, side)};`, ""];
    if (!printable && !index.holdsResources(type)) return declare("", "public");
    const fieldsToConvert = type.kind === "object" && type.fields.some((field) => index.holdsResources(field.type));
    const decoded = type.kind !== "object" || fieldsToConvert ? decode(type, "data") : "{ ...data }";
    return [
      ...declare("", "public"),
      ...declare("Wire", "wire"),
      `function decode${name}(${fieldsToConvert || type.kind !== "object" ? "ctx" : "_ctx"}: HandleContext, data: ${name}Wire): ${name} {`,
      printable ? `  return printsAs(${decoded}, data.${stringField});` : `  return ${decoded};`,
      "}",
      "",
    ];
  };

  const disposes = ir.resources.some((resource) => resource.name !== ir.root && index.disposer(resource) !== undefined);
  const usesDurations = JSON.stringify(ir).includes('"kind":"duration"');
  const usesFiles = JSON.stringify(ir).includes('"kind":"files"');
  const allWaits = ir.resources.flatMap((resource) => resource.waits ?? []);
  const allMethods = ir.resources.flatMap((resource) => resource.methods);
  const waitImports = [
    ...(allWaits.some((w) => w.from !== undefined) ? ["describeWait", "fromMatches"] : []),
    ...(allWaits.some((w) => w.text !== undefined) ? ["textMatches"] : []),
    ...(allWaits.some((w) => w.mode === "latest") ? ["latestOnceQuiet", "type QuietOptions"] : []),
    ...(allWaits.some((w) => w.mode === "until") ? ["waitFor"] : []),
    ...(allWaits.some((w) => w.mode === "next") ? ["waitForNext"] : []),
    ...(allWaits.some((w) => w.mode !== "latest") ? ["type WaitOptions"] : []),
    ...(allMethods.some((m) => m.retryWhile) ? ["retryWhile"] : []),
    ...(allMethods.some((m) => m.onceQuiet) ? ["untilQuiet"] : []),
    ...(JSON.stringify(ir).includes('"kind":"pattern"') ? ["patternOnWire"] : []),
  ];
  const usesCredentials = JSON.stringify(ir).includes('"credential":');
  const usesSession = ir.resources.some((resource) =>
    resource.methods.some((m) => m.http.pathParams.some((p) => p.from === "session")),
  );
  const spec = JSON.stringify(ir);
  const lines = [
    `// ${BANNER}`,
    `import { ClientBase, connectWith${disposes ? ", disposeQuietly" : ""}, type HandleContext${ir.types.some((type) => type.stringField !== undefined) ? ", printsAs" : ""}, QUIET, quietOf${usesSession ? ", sessionOf" : ""} } from "../runtime/client.ts";`,
    ...(usesCredentials ? ['import { credential } from "../runtime/credentials.ts";'] : []),
    ...(usesDurations ? ['import { type Duration, parseDuration } from "../runtime/duration.ts";'] : []),
    ...(usesFiles
      ? [
          `import { ${[
            ...(spec.includes('"mode":"tree"') || spec.includes('"mode":"changes"') ? ["type FileInput"] : []),
            ...(spec.includes('"mode":"changes"') ? ["readChanges"] : []),
            ...(spec.includes('"mode":"document"') ? ["readDocument"] : []),
            ...(spec.includes('"mode":"tree"') ? ["readTree"] : []),
          ].join(", ")} } from "../runtime/files.ts";`,
        ]
      : []),
    'import type { LaunchOptions } from "../runtime/launcher.ts";',
    ...(ir.resources.some((resource) => resource.methods.some((m) => m.responder))
      ? ['import { type Responder, respondWith } from "../runtime/responder.ts";']
      : []),
    'import { ChannelstackError, type ErrorClasses, segment, type Transport } from "../runtime/transport.ts";',
    `import { ${[...waitImports, "type QuietState"].join(", ")} } from "../runtime/wait.ts";`,
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
  return new Map([
    [OUT, lines.join("\n")],
    [CHANNELS_OUT, channelsFile(ir)],
  ]);
}
