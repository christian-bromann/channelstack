import type { Ir, IrField, IrMethod, IrParam, IrResource, IrType, IrWait } from "../ir.ts";
import { BANNER, errorClassName, IrIndex, pathParts, snakeCase as toSnakeCase } from "./shared.ts";

/** Words Python reserves. A name that collides gets a trailing underscore, as PEP 8 recommends (`as_`). */
const KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);

/** A Python identifier for an IR name: snake_case, and never a keyword. */
function snakeCase(name: string): string {
  const snake = toSnakeCase(name);
  return KEYWORDS.has(snake) ? `${snake}_` : snake;
}

const OUT = "sdks/python/channelstack/generated/__init__.py";

/** The Python SDK's generated half: async handle classes, frozen dataclasses for data, typed errors. */
export function emitPython(ir: Ir): Map<string, string> {
  const index = new IrIndex(ir);
  const namedTypes = new Map(ir.types.map((type) => [type.name, type.type]));
  const isDataclass = (name: string) => namedTypes.get(name)?.kind === "object";

  /** Named types that methods take as arguments: these also need a wire form. */
  const inputTypes = new Set(
    ir.resources
      .flatMap((resource) => resource.methods)
      .flatMap((m) => [...m.args, ...m.options])
      .map((param) => param.type)
      .filter((type) => type.kind === "named")
      .map((type) => type.name),
  );

  const typeOf = (type: IrType): string => {
    switch (type.kind) {
      case "string":
        return "str";
      case "boolean":
        return "bool";
      case "number":
        return "float";
      case "integer":
        return "int";
      case "duration":
        return "Duration";
      case "unknown":
        return "Any";
      case "literal":
        return `Literal[${typeof type.value === "boolean" ? (type.value ? "True" : "False") : JSON.stringify(type.value)}]`;
      case "enum":
        return `Literal[${type.values.map((value) => JSON.stringify(value)).join(", ")}]`;
      case "array":
        return type.oneOrMany ? `${typeOf(type.items)} | list[${typeOf(type.items)}]` : `list[${typeOf(type.items)}]`;
      case "record":
        return `dict[str, ${typeOf(type.values)}]`;
      case "object": {
        const short = type.fields.find((field) => field.name === type.shorthand);
        return short ? `${typeOf(short.type)} | dict[str, Any]` : "dict[str, Any]";
      }
      case "files":
        return { tree: "TreeInput", changes: "ChangesInput", document: "DocumentInput" }[type.mode];
      case "pattern":
        return "str | re.Pattern[str]";
      case "named":
      case "resource":
        return type.name;
      case "ref":
        return type.resources.join(" | ");
      case "nullable":
        return `${typeOf(type.type)} | None`;
      case "union":
        return type.types.map(typeOf).join(" | ");
    }
  };

  /** Does wire data of this type have to be converted (into a dataclass or a handle)? */
  const converts = (type: IrType): boolean => {
    switch (type.kind) {
      case "resource":
        return true;
      case "named":
        return isDataclass(type.name) || converts(namedTypes.get(type.name) ?? { kind: "unknown" });
      case "array":
        return converts(type.items);
      case "record":
        return converts(type.values);
      case "nullable":
        return true;
      case "union":
        return type.types.some(converts);
      default:
        return false;
    }
  };

  const decode = (type: IrType, expr: string): string => {
    if (!converts(type)) return expr;
    switch (type.kind) {
      case "resource": {
        const resource = index.resource(type.name);
        const context =
          resource.scope === "session"
            ? `HandleContext(ctx.transport, ${expr}[${JSON.stringify(resource.idFields?.[0])}])`
            : "ctx";
        return `${type.name}(${context}, ${expr})`;
      }
      case "named":
        return isDataclass(type.name)
          ? `${type.name}._from_wire(ctx, ${expr})`
          : decode(namedTypes.get(type.name) ?? { kind: "unknown" }, expr);
      case "array":
        return `[${decode(type.items, "item")} for item in ${expr}]`;
      case "nullable":
        return `(None if ${expr} is None else ${decode(type.type, expr)})`;
      case "record":
        return `{key: ${decode(type.values, "value")} for key, value in ${expr}.items()}`;
      case "union": {
        // Handle data in a union is told apart by its discriminator field, e.g. `kind: "user" | "app"`.
        const members = index.discriminated(type);
        if (!members)
          throw new Error("A union that holds handles needs a discriminator every member declares as a literal");
        const key = JSON.stringify(type.discriminator);
        return members
          .map(({ value, member }, position) =>
            position === members.length - 1
              ? decode(member, expr)
              : `${decode(member, expr)} if ${expr}[${key}] == ${JSON.stringify(value)} else `,
          )
          .join("");
      }
      default:
        throw new Error(`Can't decode a ${type.kind}`);
    }
  };

  const fieldDecode = (field: IrField, data: string): string => {
    const key = JSON.stringify(field.name);
    if (!field.optional) return decode(field.type, `${data}[${key}]`);
    if (!converts(field.type)) return `${data}.get(${key})`;
    return `None if ${data}.get(${key}) is None else ${decode(field.type, `${data}[${key}]`)}`;
  };

  const annotation = (field: IrField) => `${typeOf(field.type)}${field.optional ? " | None" : ""}`;

  /** Does a value of this type have to be converted before it goes on the wire? */
  const holdsRefs = (type: IrType): boolean =>
    type.kind === "ref" ||
    type.kind === "duration" ||
    type.kind === "files" ||
    type.kind === "pattern" ||
    (type.kind === "named" && isDataclass(type.name)) ||
    (type.kind === "array" && (type.oneOrMany === true || holdsRefs(type.items))) ||
    (type.kind === "object" && (type.shorthand !== undefined || type.fields.some((field) => holdsRefs(field.type))));

  /** An expression that turns a value into what goes on the wire: handles become their ids. */
  const encodeValue = (type: IrType, expr: string): string => {
    if (!holdsRefs(type)) return expr;
    if (type.kind === "ref") {
      const idFields = index.refIdFields(type.resources);
      const [only] = idFields;
      return idFields.length === 1 && only !== undefined
        ? `${expr}.${snakeCase(only)}`
        : `{${idFields.map((id) => `${JSON.stringify(id)}: ${expr}.${snakeCase(id)}`).join(", ")}}`;
    }
    if (type.kind === "duration") return `parse_duration(${expr})`;
    if (type.kind === "files")
      return `${{ tree: "read_tree", changes: "read_changes", document: "read_document" }[type.mode]}(${expr})`;
    if (type.kind === "pattern") return `pattern_on_wire(${expr})`;
    if (type.kind === "array") {
      const list = type.oneOrMany ? `(${expr} if isinstance(${expr}, list) else [${expr}])` : expr;
      const item = encodeValue(type.items, "item");
      return item === "item" ? list : `[${item} for item in ${list}]`;
    }
    // A named input type is a dataclass that knows its own wire form.
    if (type.kind === "named") return `${expr}._to_wire()`;
    if (type.kind === "object") {
      // An object argument is a dict with the API's own key names; what it holds is converted, and absent keys stay absent.
      const converted = type.fields
        .filter((field) => holdsRefs(field.type))
        .map((field) => {
          const key = JSON.stringify(field.name);
          const value = encodeValue(field.type, `${expr}[${key}]`);
          return `${key}: None if ${expr}.get(${key}) is None else ${value}`;
        });
      const whole =
        converted.length > 0
          ? `{key: value for key, value in {**${expr}, ${converted.join(", ")}}.items() if value is not None}`
          : expr;
      const short = type.fields.find((field) => field.name === type.shorthand);
      if (!short) return whole;
      // The value of one field stands for the whole object: a handle, or a plain string.
      const given = short.type.kind === "ref" ? `(${short.type.resources.join(", ")},)` : "str";
      return `({${JSON.stringify(short.name)}: ${encodeValue(short.type, expr)}} if isinstance(${expr}, ${given}) else ${whole})`;
    }
    return expr;
  };

  /** An argument or option as it goes on the wire. A string where an object is expected is its shorthand. */
  const encode = (param: IrParam): string => {
    const name = snakeCase(param.name);
    const encoded = encodeValue(param.type, name);
    const value =
      param.shorthand === undefined
        ? encoded
        : `{${JSON.stringify(param.shorthand)}: ${name}} if isinstance(${name}, str) else ${encoded}`;
    if (param.credential !== undefined) {
      // Left out, it comes from the environment: the same test runs fake on PRs and live nightly.
      const fields = [...param.credential.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
      const values = fields.map((field) => `${JSON.stringify(field)}: ${snakeCase(field)}`).join(", ");
      return `credential(${JSON.stringify(param.credential)}, {${values}}) if ${name} is None else ${value}`;
    }
    return param.optional && value !== name ? `None if ${name} is None else ${value}` : value;
  };

  const parameterType = (param: IrParam): string =>
    `${param.shorthand === undefined ? "" : "str | "}${typeOf(param.type)}`;

  const method = (m: IrMethod): string[] => {
    const parameters = [
      "self",
      ...m.args.map((arg) => `${snakeCase(arg.name)}: ${parameterType(arg)}${arg.optional ? " | None = None" : ""}`),
      ...(m.options.length > 0 ? ["*"] : []),
      ...m.options.map(
        (option) =>
          `${snakeCase(option.name)}: ${option.shorthand === undefined ? "" : "str | "}${annotation(option)}${option.optional ? " = None" : ""}`,
      ),
    ];
    const path = pathParts(m)
      .map((part) => {
        if (typeof part === "string") return part;
        return part.from === "session"
          ? "{quote(session_of(ctx), safe='')}"
          : `{quote(str(self.${snakeCase(part.field ?? "")}), safe='')}`;
      })
      .join("");
    const params = [...m.args, ...m.options];
    const dict = (where: "body" | "query") => {
      const entries = params
        .filter((param) => param.in === where)
        .map((param) => `${JSON.stringify(param.name)}: ${encode(param)}`);
      return entries.length > 0 ? [`${where}={${entries.join(", ")}}`] : [];
    };
    const sent = `ctx.transport.request(${[JSON.stringify(m.http.verb), `f"${path}"`, ...dict("body"), ...dict("query")].join(", ")})`;
    const call = m.retryWhile
      ? `await retry_while((${m.retryWhile.map((code) => JSON.stringify(code)).join(", ")},), lambda: ${sent})`
      : `await ${sent}`;
    return [
      "",
      `    async def ${snakeCase(m.name)}(${parameters.join(", ")}) -> ${m.returns ? typeOf(m.returns) : "None"}:`,
      `        """${m.summary}.${m.stability === "experimental" ? " Experimental." : ""}"""`,
      "        ctx = self._ctx",
      ...(m.onceQuiet ? ["        await until_quiet(lambda: quiet_of(ctx))"] : []),
      ...(m.returns ? [`        data = ${call}`, `        return ${decode(m.returns, "data")}`] : [`        ${call}`]),
    ];
  };

  /** `thread.wait_for_reply()`, `thread.latest_reply()`: waits generated from a list read. */
  const wait = (resource: IrResource, w: IrWait): string[] => {
    // With `filter`, the read's own options are keyword arguments of the wait and passed through to it.
    const read = resource.methods.find((m) => m.name === w.read);
    const filters = w.filter && read ? read.options : [];
    const passed = filters.map((option) => `${snakeCase(option.name)}=${snakeCase(option.name)}`).join(", ");
    const reader = filters.length > 0 ? `lambda: self.${snakeCase(w.read)}(${passed})` : `self.${snakeCase(w.read)}`;
    const fromField =
      w.item.kind === "resource" ? index.resource(w.item.name).fields.find((f) => f.name === w.from) : undefined;
    const from = fromField ? [`from_: ${typeOf(fromField.type)} | str | None = None`] : [];
    const parameters = [
      "self",
      "*",
      ...filters.map((option) => `${snakeCase(option.name)}: ${annotation(option)}${option.optional ? " = None" : ""}`),
      ...from,
      ...(w.text ? [`${snakeCase(w.text)}: Text | None = None`] : []),
      // The defaults are the runtime's (`set_wait_defaults`), so a test framework's settings reach every wait.
      "timeout: Duration | None = None",
      ...(w.mode === "latest" ? ["quiet_for: Duration | None = None"] : []),
    ];
    const conditions = [
      ...(fromField ? [`from_matches(item.${snakeCase(w.from ?? "")}, from_)`] : []),
      ...(w.text ? [`text_matches(item.${snakeCase(w.text)}, ${snakeCase(w.text)})`] : []),
    ];
    const matches = `lambda item: ${conditions.length > 0 ? conditions.join(" and ") : "True"}`;
    const what = fromField ? `describe_wait(${JSON.stringify(w.what)}, from_)` : JSON.stringify(w.what);
    const noun = w.what.replace(/^an? /, "");
    if (w.mode === "until" && w.in) {
      const value = w.field === undefined ? "value" : `value.${snakeCase(w.field)}`;
      return [
        "",
        `    async def ${snakeCase(w.name)}(self, wanted: ${typeOf(w.item)} | list[${typeOf(w.item)}], *, timeout: Duration | None = None) -> ${typeOf(w.item)}:`,
        `        """Wait for ${w.what}: one of the values given. Resolves with the value as it is then."""`,
        "        values = wanted if isinstance(wanted, list) else [wanted]",
        "",
        `        async def reached() -> ${typeOf(w.item)} | None:`,
        `            value = await self.${snakeCase(w.read)}()`,
        `            return value if ${value} in values else None`,
        "",
        `        return await wait_for(${JSON.stringify(w.what)}, reached, timeout=timeout)`,
      ];
    }
    if (w.mode === "until") {
      const pending = `value.${snakeCase(w.field ?? "")} in (${(w.not ?? []).map((value) => JSON.stringify(value)).join(", ")},)`;
      return [
        "",
        `    async def ${snakeCase(w.name)}(self, *, timeout: Duration | None = None) -> ${typeOf(w.item)}:`,
        `        """Wait for ${w.what}, and resolve with the value as it is then."""`,
        "",
        `        async def settled() -> ${typeOf(w.item)} | None:`,
        `            value = await self.${snakeCase(w.read)}()`,
        `            return None if ${pending} else value`,
        "",
        `        return await wait_for(${JSON.stringify(w.what)}, settled, timeout=timeout)`,
      ];
    }
    return [
      "",
      `    async def ${snakeCase(w.name)}(${parameters.join(", ")}) -> ${typeOf(w.item)}:`,
      w.mode === "next"
        ? `        """Wait for the next new ${noun}${fromField ? " matching `from_` (anyone if omitted)" : ""}, after the last one this handle saw."""`
        : `        """The latest ${noun}${fromField ? " matching `from_`" : ""}, once the agent is quiet. Waits for at least one."""`,
      w.mode === "next"
        ? // A filtered read is its own list, so each filter keeps its own place in it.
          `        return await wait_for_next(self._seen, ${filters.length > 0 ? `f"${w.name}:${filters.map((option) => `{${snakeCase(option.name)}!r}`).join(":")}"` : JSON.stringify(w.name)}, ${reader}, ${matches}, ${what}, timeout=timeout${w.turn ? `, starts_turn=lambda item: item.${snakeCase(w.turn.field)} == ${JSON.stringify(w.turn.value)}` : ""})`
        : `        return await latest_once_quiet(${reader}, ${matches}, lambda: quiet_of(self._ctx), ${what}, timeout=timeout, quiet_for=quiet_for)`,
    ];
  };

  const allWaits = ir.resources.flatMap((resource) => resource.waits ?? []);
  const usesDurations = JSON.stringify(ir).includes('"kind":"duration"');
  const usesFiles = JSON.stringify(ir).includes('"kind":"files"');

  /** Does a resource this one extends already keep the `_seen` map its waits use? */
  const inheritsSeen = (resource: IrResource): boolean => {
    if (resource.extends === undefined) return false;
    const parent = index.resource(resource.extends);
    return (parent.waits ?? []).some((w) => w.mode === "next") || inheritsSeen(parent);
  };

  const resourceClass = (resource: IrResource): string[] => {
    const isRoot = resource.name === ir.root;
    const disposer = isRoot ? undefined : index.disposer(resource);
    const waits = resource.waits ?? [];
    return [
      "",
      "",
      `class ${resource.name}${isRoot ? "(ClientBase)" : resource.extends === undefined ? "" : `(${resource.extends})`}:`,
      ...(isRoot
        ? [
            "    def __init__(self, transport: Transport, stop: Callable[[], Awaitable[None]]) -> None:",
            "        super().__init__(transport, stop)",
            "        self._ctx = HandleContext(transport, None)",
          ]
        : [
            "    def __init__(self, ctx: HandleContext, data: dict[str, Any]) -> None:",
            ...(resource.extends === undefined ? ["        self._ctx = ctx"] : ["        super().__init__(ctx, data)"]),
            // A handle that extends another shares its parent's place in the lists it waits on.
            ...(waits.some((w) => w.mode === "next") && !inheritsSeen(resource)
              ? ["        self._seen: dict[str, int] = {}"]
              : []),
            ...index
              .ownFields(resource)
              .map(
                (field) =>
                  `        self.${snakeCase(field.name)}: ${annotation(field)} = ${fieldDecode(field, "data")}`,
              ),
          ]),
      ...resource.methods.flatMap(method),
      ...waits.flatMap((w) => wait(resource, w)),
      ...(disposer
        ? [
            "",
            "    async def __aenter__(self) -> Self:",
            "        return self",
            "",
            "    async def __aexit__(self, *_: object) -> None:",
            `        await dispose_quietly(self.${snakeCase(disposer.name)})`,
          ]
        : []),
    ];
  };

  const dataType = ({ name, type, stringField }: Ir["types"][number]): string[] => {
    // A `type` statement is evaluated lazily, so an alias can name a class declared after it.
    if (type.kind !== "object") return ["", "", `type ${name} = ${typeOf(type)}`];
    // Dataclass fields without a default must come first.
    const ordered = [
      ...type.fields.filter((field) => !field.optional),
      ...type.fields.filter((field) => field.optional),
    ];
    return [
      "",
      "",
      "@dataclass(frozen=True)",
      `class ${name}:`,
      ...ordered.map((field) => `    ${snakeCase(field.name)}: ${annotation(field)}${field.optional ? " = None" : ""}`),
      "",
      "    @classmethod",
      `    def _from_wire(cls, ctx: HandleContext, data: dict[str, Any]) -> ${name}:`,
      "        return cls(",
      ...ordered.map((field) => `            ${snakeCase(field.name)}=${fieldDecode(field, "data")},`),
      "        )",
      ...(stringField === undefined
        ? []
        : ["", "    def __str__(self) -> str:", `        return self.${snakeCase(stringField)}`]),
      ...(inputTypes.has(name)
        ? [
            "",
            "    def _to_wire(self) -> dict[str, Any]:",
            `        wire = {${ordered.map((field) => `${JSON.stringify(field.name)}: self.${snakeCase(field.name)}`).join(", ")}}`,
            "        return {key: value for key, value in wire.items() if value is not None}",
          ]
        : []),
    ];
  };

  const exported = [
    "VERSION",
    "ChannelstackError",
    "connect",
    ...ir.errors.map(errorClassName),
    ...ir.types.map((type) => type.name),
    ...ir.resources.map((resource) => resource.name),
  ].sort();

  const allMethods = ir.resources.flatMap((resource) => resource.methods);
  const usesText = allWaits.some((w) => w.text !== undefined);
  // In the order ruff sorts them: capitalized names first, then the rest by name.
  const waitImports = [
    ...(usesText ? ["Text"] : []),
    ...(allWaits.length > 0 ? ["describe_wait", "from_matches", "latest_once_quiet"] : []),
    ...(allMethods.some((m) => m.retryWhile) ? ["retry_while"] : []),
    ...(usesText ? ["text_matches"] : []),
    ...(allMethods.some((m) => m.onceQuiet) ? ["until_quiet"] : []),
    ...(allWaits.length > 0 ? ["wait_for", "wait_for_next"] : []),
    ...(JSON.stringify(ir).includes('"kind":"pattern"') ? ["pattern_on_wire"] : []),
  ];
  const spec = JSON.stringify(ir);
  const lines = [
    `# ${BANNER}`,
    "# ruff: noqa",
    "# The classes build each other from the wire: `_from_wire` is private to this module, not to its class.",
    "# pyright: reportPrivateUsage=false",
    "from __future__ import annotations",
    "",
    ...(JSON.stringify(ir).includes('"kind":"pattern"') ? ["import re"] : []),
    "from collections.abc import Awaitable, Callable",
    "from dataclasses import dataclass",
    "from typing import Any, Literal, Self",
    "from urllib.parse import quote",
    "",
    `from ..runtime.client import ClientBase, HandleContext, Protocol, connect_with, dispose_quietly${allWaits.some((w) => w.mode === "latest") || allMethods.some((m) => m.onceQuiet) ? ", quiet_of" : ""}, session_of`,
    ...(spec.includes('"credential":') ? ["from ..runtime.credentials import credential"] : []),
    ...(usesDurations || allWaits.length > 0
      ? [`from ..runtime.duration import Duration${usesDurations ? ", parse_duration" : ""}`]
      : []),
    ...(usesFiles
      ? [
          `from ..runtime.files import ${[
            ...(spec.includes('"mode":"changes"') ? ["ChangesInput"] : []),
            ...(spec.includes('"mode":"document"') ? ["DocumentInput"] : []),
            ...(spec.includes('"mode":"tree"') ? ["TreeInput"] : []),
            ...(spec.includes('"mode":"changes"') ? ["read_changes"] : []),
            ...(spec.includes('"mode":"document"') ? ["read_document"] : []),
            ...(spec.includes('"mode":"tree"') ? ["read_tree"] : []),
          ].join(", ")}`,
        ]
      : []),
    "from ..runtime.transport import ChannelstackError, Transport",
    ...(waitImports.length > 0 ? [`from ..runtime.wait import ${waitImports.join(", ")}`] : []),
    "",
    `__all__ = [${exported.map((name) => JSON.stringify(name)).join(", ")}]`,
    "",
    `VERSION = ${JSON.stringify(ir.version)}`,
    ...ir.errors.flatMap((code) => ["", "", `class ${errorClassName(code)}(ChannelstackError):`, "    pass"]),
    "",
    "",
    "_ERRORS: dict[str, type[ChannelstackError]] = {",
    ...ir.errors.map((code) => `    ${JSON.stringify(code)}: ${errorClassName(code)},`),
    "}",
    ...ir.types.flatMap(dataType),
    ...ir.resources.flatMap(resourceClass),
    "",
    "",
    `async def connect(*, mode: Literal["auto", "attach", "start"] = "auto", server: str | None = None, token: str | None = None) -> ${ir.root}:`,
    '    """Attach to a running channelstack server, or start one, and return the client."""',
    `    protocol = Protocol(base_path=${JSON.stringify(ir.basePath)}, errors=_ERRORS, version=VERSION)`,
    `    return await connect_with(${ir.root}, protocol, mode=mode, server=server, token=token)`,
    "",
  ];
  return new Map([[OUT, lines.join("\n")]]);
}
