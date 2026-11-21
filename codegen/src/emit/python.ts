import type { Ir, IrField, IrMethod, IrParam, IrResource, IrType } from "../ir.ts";
import { BANNER, errorClassName, IrIndex, pathParts, snakeCase } from "./shared.ts";

const OUT = "sdks/python/channelstack/generated/__init__.py";

/** The Python SDK's generated half: async handle classes, frozen dataclasses for data, typed errors. */
export function emitPython(ir: Ir): Map<string, string> {
  const index = new IrIndex(ir);
  const namedTypes = new Map(ir.types.map((type) => [type.name, type.type]));
  const isDataclass = (name: string) => namedTypes.get(name)?.kind === "object";

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
      case "unknown":
        return "Any";
      case "literal":
        return `Literal[${JSON.stringify(type.value)}]`;
      case "enum":
        return `Literal[${type.values.map((value) => JSON.stringify(value)).join(", ")}]`;
      case "array":
        return `list[${typeOf(type.items)}]`;
      case "record":
        return `dict[str, ${typeOf(type.values)}]`;
      case "object":
        return "dict[str, Any]";
      case "named":
      case "resource":
        return type.name;
      case "ref":
        return type.resources.join(" | ");
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
            ? `HandleContext(ctx.transport, ${expr}[${JSON.stringify(resource.idField)}])`
            : "ctx";
        return `${type.name}(${context}, ${expr})`;
      }
      case "named":
        return isDataclass(type.name)
          ? `${type.name}._from_wire(ctx, ${expr})`
          : decode(namedTypes.get(type.name) ?? { kind: "unknown" }, expr);
      case "array":
        return `[${decode(type.items, "item")} for item in ${expr}]`;
      case "record":
        return `{key: ${decode(type.values, "value")} for key, value in ${expr}.items()}`;
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

  const encode = (param: IrParam): string => {
    const name = snakeCase(param.name);
    const guard = (expr: string) => (param.optional ? `None if ${name} is None else ${expr}` : expr);
    if (param.type.kind === "ref") return guard(`${name}.${snakeCase(index.refIdField(param.type.resources))}`);
    if (param.type.kind === "array" && param.type.items.kind === "ref") {
      return guard(`[item.${snakeCase(index.refIdField(param.type.items.resources))} for item in ${name}]`);
    }
    return name;
  };

  const method = (m: IrMethod): string[] => {
    const parameters = [
      "self",
      ...m.args.map((arg) => `${snakeCase(arg.name)}: ${typeOf(arg.type)}`),
      ...(m.options.length > 0 ? ["*"] : []),
      ...m.options.map(
        (option) => `${snakeCase(option.name)}: ${annotation(option)}${option.optional ? " = None" : ""}`,
      ),
    ];
    const path = pathParts(m)
      .map((part) => {
        if (typeof part === "string") return part;
        return part.from === "session"
          ? "{quote(session_of(ctx), safe='')}"
          : `{quote(self.${snakeCase(part.field ?? "")}, safe='')}`;
      })
      .join("");
    const params = [...m.args, ...m.options];
    const dict = (where: "body" | "query") => {
      const entries = params
        .filter((param) => param.in === where)
        .map((param) => `${JSON.stringify(param.name)}: ${encode(param)}`);
      return entries.length > 0 ? [`${where}={${entries.join(", ")}}`] : [];
    };
    const call = `await ctx.transport.request(${[JSON.stringify(m.http.verb), `f"${path}"`, ...dict("body"), ...dict("query")].join(", ")})`;
    return [
      "",
      `    async def ${snakeCase(m.name)}(${parameters.join(", ")}) -> ${m.returns ? typeOf(m.returns) : "None"}:`,
      `        """${m.summary}.${m.stability === "experimental" ? " Experimental." : ""}"""`,
      "        ctx = self._ctx",
      ...(m.returns ? [`        data = ${call}`, `        return ${decode(m.returns, "data")}`] : [`        ${call}`]),
    ];
  };

  const resourceClass = (resource: IrResource): string[] => {
    const isRoot = resource.name === ir.root;
    const disposer = isRoot ? undefined : index.disposer(resource);
    return [
      "",
      "",
      `class ${resource.name}${isRoot ? "(ClientBase)" : ""}:`,
      ...(isRoot
        ? [
            "    def __init__(self, transport: Transport, stop: Callable[[], Awaitable[None]]) -> None:",
            "        super().__init__(transport, stop)",
            "        self._ctx = HandleContext(transport, None)",
          ]
        : [
            "    def __init__(self, ctx: HandleContext, data: dict[str, Any]) -> None:",
            "        self._ctx = ctx",
            ...resource.fields.map(
              (field) => `        self.${snakeCase(field.name)}: ${annotation(field)} = ${fieldDecode(field, "data")}`,
            ),
          ]),
      ...resource.methods.flatMap(method),
      ...(disposer
        ? [
            "",
            "    async def __aenter__(self) -> Self:",
            "        return self",
            "",
            "    async def __aexit__(self, *_: object) -> None:",
            `        await self.${snakeCase(disposer.name)}()`,
          ]
        : []),
    ];
  };

  const dataType = ({ name, type }: Ir["types"][number]): string[] => {
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

  const lines = [
    `# ${BANNER}`,
    "# ruff: noqa",
    "from __future__ import annotations",
    "",
    "from collections.abc import Awaitable, Callable",
    "from dataclasses import dataclass",
    "from typing import Any, Literal, Self",
    "from urllib.parse import quote",
    "",
    "from ..runtime.client import ClientBase, HandleContext, Protocol, connect_with, session_of",
    "from ..runtime.transport import ChannelstackError, Transport",
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
    `async def connect(*, mode: Literal["auto", "attach", "start"] = "auto", server: str | None = None) -> ${ir.root}:`,
    '    """Attach to a running channelstack server, or start one, and return the client."""',
    `    protocol = Protocol(base_path=${JSON.stringify(ir.basePath)}, errors=_ERRORS, version=VERSION)`,
    `    return await connect_with(${ir.root}, protocol, mode=mode, server=server)`,
    "",
  ];
  return new Map([[OUT, lines.join("\n")]]);
}
