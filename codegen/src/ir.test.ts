import { describe, expect, test } from "vitest";

import { emitDocs } from "./emit/docs.ts";
import { emitPython } from "./emit/python.ts";
import { emitTypeScript } from "./emit/typescript.ts";
import { buildIr } from "./ir.ts";

const json = (schema: object) => ({ content: { "application/json": { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A small spec with every construct the builder supports. */
function spec(overrides: { operation?: object; schemas?: object } = {}) {
  return {
    info: { version: "1.2.3" },
    servers: [{ url: "/_channelstack" }],
    components: {
      schemas: {
        Session: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string" } },
          "x-channelstack-resource": { id: "sessionId", scope: "session" },
        },
        Widget: {
          type: "object",
          required: ["id", "owner", "kind"],
          properties: {
            id: { type: "string" },
            owner: ref("Person"),
            kind: { type: "string", enum: ["widget"] },
            size: { type: "integer" },
          },
          "x-channelstack-resource": { id: "id" },
        },
        Person: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
        },
        WidgetBody: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string" },
            parent: { type: "string", "x-channelstack-ref": ["Widget"] },
            mode: { type: "string", enum: ["a", "b"], default: "a" },
          },
        },
        Unused: { type: "object", properties: { x: { type: "string" } } },
        ...overrides.schemas,
      },
    },
    paths: {
      "/sessions": {
        post: {
          summary: "Open",
          responses: { 200: json(ref("Session")) },
          "x-channelstack-factory": { on: "Channelstack", name: "openSession" },
        },
      },
      "/sessions/{session}/widgets/{widget}": {
        post: {
          summary: "Update a widget",
          parameters: [
            { name: "session", in: "path", required: true, schema: { type: "string" } },
            { name: "widget", in: "path", required: true, schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string" } },
          ],
          requestBody: json(ref("WidgetBody")),
          responses: {
            200: json({
              type: "object",
              required: ["items"],
              properties: { items: { type: "array", items: ref("Widget") } },
            }),
          },
          "x-channelstack-method": {
            on: "Widget",
            name: "update",
            args: ["label"],
            options: ["parent", "mode", "since"],
          },
          "x-channelstack-error-codes": ["not_found", "unauthorized"],
          "x-channelstack-stability": "stable",
          ...overrides.operation,
        },
      },
    },
  };
}

describe("OpenAPI → IR", () => {
  test("operations become methods on handles, with path parameters bound and handles sent by id", () => {
    const ir = buildIr(spec());
    expect(ir).toMatchObject({
      version: "1.2.3",
      basePath: "/_channelstack",
      root: "Channelstack",
      errors: ["not_found", "unauthorized"],
    });
    expect(ir.resources.map((resource) => resource.name)).toEqual(["Channelstack", "Session", "Widget"]);
    expect(ir.resources[1]).toMatchObject({ idFields: ["sessionId"], scope: "session" });

    const update = ir.resources[2]?.methods[0];
    expect(update).toMatchObject({
      name: "update",
      kind: "method",
      stability: "stable",
      http: {
        verb: "POST",
        path: "/sessions/{session}/widgets/{widget}",
        pathParams: [
          { name: "session", from: "session" },
          { name: "widget", from: "self", field: "id" },
        ],
      },
      args: [{ name: "label", in: "body", optional: false, type: { kind: "string" } }],
      options: [
        { name: "parent", in: "body", optional: true, type: { kind: "ref", resources: ["Widget"] } },
        { name: "mode", in: "body", optional: true, type: { kind: "enum", values: ["a", "b"] } },
        { name: "since", in: "query", optional: true },
      ],
      returns: {
        kind: "object",
        fields: [{ name: "items", type: { kind: "array", items: { kind: "resource", name: "Widget" } } }],
      },
    });
    expect(ir.resources[0]?.methods[0]).toMatchObject({
      name: "openSession",
      kind: "factory",
      returns: { kind: "resource", name: "Session" },
    });
    // Only data types a response or a handle can reach are part of the surface: no request bodies, nothing unused.
    expect(ir.types.map((type) => type.name)).toEqual(["Person"]);
    expect(ir.resources[2]?.fields.find((field) => field.name === "kind")?.type).toEqual({
      kind: "literal",
      value: "widget",
    });
  });

  test("what a method needs live, and what channelstack's own error codes mean, come along", () => {
    const live = { requires: "browser", reason: "no API does it as a person" };
    const document = {
      ...spec({ operation: { "x-channelstack-live": live } }),
      "x-channelstack-errors": { not_found: { status: 404, description: "It isn't there." } },
    };
    const ir = buildIr(document);
    expect(ir.resources[2]?.methods[0]?.live).toEqual(live);
    expect(ir.resources[0]?.methods[0]?.live).toBeUndefined();
    expect(ir.errorDocs).toEqual({ not_found: { status: 404, description: "It isn't there." } });
    expect(() => buildIr(spec({ operation: { "x-channelstack-live": { requires: "magic" } } }))).toThrow(
      /x-channelstack-live needs/,
    );
  });

  test.each([
    [
      "an operation with no SDK binding",
      { "x-channelstack-method": undefined },
      /neither x-channelstack-method nor x-channelstack-factory/,
    ],
    [
      "a binding to an unknown resource",
      { "x-channelstack-method": { on: "Gadget", name: "x" } },
      /unknown resource "Gadget"/,
    ],
    [
      "a body field no method exposes",
      { "x-channelstack-method": { on: "Widget", name: "update", args: ["label"], options: ["since"] } },
      /doesn't expose parent, mode/,
    ],
    [
      "a binding to a field that doesn't exist",
      { "x-channelstack-method": { on: "Widget", name: "update", args: ["nope"] } },
      /binds "nope"/,
    ],
    [
      "an optional field before another positional argument",
      {
        "x-channelstack-method": {
          on: "Widget",
          name: "update",
          args: ["parent", "label"],
          options: ["mode", "since"],
        },
      },
      /"parent" must be an option/,
    ],
    [
      "a path parameter that can't be bound",
      {
        "x-channelstack-method": {
          on: "Channelstack",
          name: "update",
          args: ["label"],
          options: ["parent", "mode", "since"],
        },
      },
      /can't bind path parameter "widget"/,
    ],
    ["a body that isn't an object", { requestBody: json({ type: "string" }) }, /request bodies must be JSON objects/],
  ])("%s is refused", (_what, operation, message) => {
    expect(() => buildIr(spec({ operation }))).toThrow(message);
  });

  test.each([
    [
      "a reference to an unknown resource",
      { Bad: { type: "object", properties: { x: { type: "string", "x-channelstack-ref": ["Nope"] } } } },
      /unknown resource "Nope"/,
    ],
    [
      "a resource whose id field is missing",
      { Bad: { type: "object", properties: {}, "x-channelstack-resource": { id: "id" } } },
      /names id field "id"/,
    ],
    ["a schema the IR can't express", { Bad: { not: { type: "string" } } }, /unsupported schema/],
    [
      "a reference to a missing schema",
      { Bad: { type: "object", properties: { x: ref("Missing") } } },
      /unknown schema "Missing"/,
    ],
  ])("%s is refused", (_what, schemas, message) => {
    expect(() => buildIr(spec({ schemas }))).toThrow(message);
  });
});

describe("emitters", () => {
  const ir = buildIr(spec());

  test("TypeScript: handles as arguments, ids on the wire, handles again in the result", () => {
    const [[path, code] = ["", ""]] = [...emitTypeScript(ir)];
    expect(path).toBe("sdks/typescript/generated/index.ts");
    expect(code).toContain(
      'async update(label: string, options: { parent?: Widget; mode?: "a" | "b"; since?: string } = {}): Promise<{ items: Widget[] }>',
    );
    expect(code).toContain("`/sessions/$" + "{segment(sessionOf(ctx))}/widgets/$" + "{segment(this.id)}`");
    expect(code).toContain(
      "body: { label, parent: options.parent === undefined ? undefined : options.parent.id, mode: options.mode }, query: { since: options.since }",
    );
    expect(code).toContain("items: data.items.map((item) => new Widget(ctx, item))");
    expect(code).toContain("new Session({ transport: ctx.transport, session: data.sessionId }, data)");
    expect(code).toContain("export class NotFoundError extends ChannelstackError {}");
  });

  test("Python: snake_case, keyword options, the same wire format", () => {
    const [[path, code] = ["", ""]] = [...emitPython(ir)];
    expect(path).toBe("sdks/python/channelstack/generated/__init__.py");
    expect(code).toContain(
      'async def update(self, label: str, *, parent: Widget | None = None, mode: Literal["a", "b"] | None = None, since: str | None = None) -> dict[str, Any]:',
    );
    expect(code).toContain("f\"/sessions/{quote(session_of(ctx), safe='')}/widgets/{quote(str(self.id), safe='')}\"");
    expect(code).toContain(
      'body={"label": label, "parent": None if parent is None else parent.id, "mode": mode}, query={"since": since}',
    );
    expect(code).toContain('Session(HandleContext(ctx.transport, data["sessionId"]), data)');
    expect(code).toContain("async def open_session(self) -> Session:");
    expect(code).toContain("class NotFoundError(ChannelstackError):");
  });

  test("Docs: each call in every SDK's language, its parameters, and the error codes explained", () => {
    const base = spec({
      schemas: {
        EchoRoom: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          "x-channelstack-resource": { id: "id" },
        },
      },
    });
    const documented = buildIr({
      ...base,
      paths: {
        ...base.paths,
        // Echo is channelstack's own test platform: a code only it raises isn't documented.
        "/sessions/{session}/rooms/{room}": {
          post: {
            summary: "Join a room",
            parameters: [
              { name: "session", in: "path", required: true, schema: { type: "string" } },
              { name: "room", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: { 200: json(ref("EchoRoom")) },
            "x-channelstack-method": { on: "EchoRoom", name: "join" },
            "x-channelstack-error-codes": ["not_in_room"],
          },
        },
      },
      "x-channelstack-errors": { not_found: { status: 404, description: "It isn't there." } },
    });
    const pages = emitDocs(documented);
    expect([...pages.keys()]).toEqual([
      "website/docs/reference/api/client.mdx",
      "website/docs/reference/api/slack.mdx",
      "website/docs/reference/api/github.mdx",
      "website/docs/reference/api/linear.mdx",
      "website/docs/reference/api/notion.mdx",
      "website/docs/reference/api/errors.mdx",
    ]);
    const client = pages.get("website/docs/reference/api/client.mdx") ?? "";
    expect(client).toContain("## Widget");
    // The result is an object, so it's `result`; the first option shows, the table lists them all.
    expect(client).toContain('const result = await widget.update("…", { parent });');
    expect(client).toContain('result = await widget.update("…", parent=parent)');
    expect(client).toContain('let result = widget.update("…").parent(&parent).await?;');
    expect(client).toContain("| `label` | `label` | `string` | yes | positional |");
    expect(client).toContain("| Parameter | Python · Rust | Type | Required | |");
    expect(client).toContain('| `mode` | `mode` | `"a" \\| "b"` | no | option |');
    const errors = pages.get("website/docs/reference/api/errors.mdx") ?? "";
    expect(errors).toContain("### not_found\n\nHTTP 404. It isn't there.");
    expect(errors).toContain("SDK class: `NotFoundError`");
    expect(errors).toContain("Rust: `Error::Api { code, .. }` with `code` equal to `codes::NOT_FOUND`.");
    expect(errors).toContain(
      "### unauthorized\n\nThe fakes refuse with it where the platform refuses the same request.",
    );
    expect(documented.errors).toContain("not_in_room");
    expect(errors).not.toContain("not_in_room");
  });
});

describe("what the GitHub surface needed", () => {
  /** A gadget that is a widget, with a numbered part, files, and people given by a handle or in full. */
  const schemas = {
    Gadget: {
      type: "object",
      required: ["id", "owner", "kind", "serial"],
      properties: {
        id: { type: "string" },
        owner: ref("Person"),
        kind: { type: "string", enum: ["widget"] },
        size: { type: "integer" },
        serial: { type: "integer" },
      },
      "x-channelstack-resource": { id: "id", extends: "Widget" },
    },
    Part: {
      type: "object",
      required: ["widgetId", "number"],
      properties: { widgetId: { type: "string" }, number: { type: "integer" } },
      "x-channelstack-resource": { id: ["widgetId", "number"] },
    },
    WidgetBody: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string" },
        parent: { type: "string", "x-channelstack-ref": ["Widget"] },
        mode: { type: "string", enum: ["a", "b"], default: "a" },
        part: {
          type: "object",
          required: ["widgetId", "number"],
          properties: { widgetId: { type: "string" }, number: { type: "integer" } },
          "x-channelstack-ref": ["Part"],
        },
        files: { type: "array", items: { type: "object" }, "x-channelstack-files": "tree" },
        changes: { type: "array", items: { type: "object" }, "x-channelstack-files": "changes" },
        helpers: {
          type: "array",
          items: {
            type: "object",
            required: ["who"],
            properties: { who: { type: "string", "x-channelstack-ref": ["Widget"] }, role: { type: "string" } },
            "x-channelstack-shorthand": "who",
          },
        },
        note: { type: ["string", "null"] },
      },
    },
  };
  const operation = {
    "x-channelstack-method": {
      on: "Widget",
      name: "update",
      args: ["label", "since"],
      options: ["parent", "mode", "part", "files", "changes", "helpers", "note"],
    },
  };
  const ir = buildIr(spec({ schemas, operation }));
  const update = ir.resources.find((resource) => resource.name === "Widget")?.methods[0];
  const option = (name: string) => update?.options.find((candidate) => candidate.name === name)?.type;

  test("the IR: a resource that extends another comes after it, and the new kinds of value are named", () => {
    const names = ir.resources.map((resource) => resource.name);
    expect(names.indexOf("Gadget")).toBeGreaterThan(names.indexOf("Widget"));
    expect(ir.resources.find((resource) => resource.name === "Gadget")).toMatchObject({ extends: "Widget" });
    expect(option("files")).toEqual({ kind: "files", mode: "tree" });
    expect(option("changes")).toEqual({ kind: "files", mode: "changes" });
    expect(option("helpers")).toMatchObject({ kind: "array", items: { kind: "object", shorthand: "who" } });
    expect(option("note")).toEqual({ kind: "nullable", type: { kind: "string" } });
    // A query parameter can be a positional argument, after the body's.
    expect(update?.args.map((arg) => [arg.name, arg.in])).toEqual([
      ["label", "body"],
      ["since", "query"],
    ]);
  });

  test.for([
    [
      "a resource that extends one that isn't there",
      {
        Bad: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          "x-channelstack-resource": { id: "id", extends: "Nope" },
        },
      },
      /extends unknown resource "Nope"/,
    ],
    [
      "a resource that extends another without having its fields",
      {
        Bad: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          "x-channelstack-resource": { id: "id", extends: "Widget" },
        },
      },
      /needs the same id and every field of it \(missing: owner, kind, size\)/,
    ],
    [
      "a shorthand that names a field the object doesn't have",
      {
        Bad: {
          type: "object",
          properties: { x: { type: "object", properties: { a: { type: "string" } }, "x-channelstack-shorthand": "b" } },
        },
      },
      /x-channelstack-shorthand names "b"/,
    ],
  ] as const)("%s is refused", ([, extra, message]) => {
    expect(() => buildIr(spec({ schemas: extra }))).toThrow(message);
  });

  test("TypeScript: a subclass, typed ids, files read on the test's side, a handle in place of an object", () => {
    const [[, code] = ["", ""]] = [...emitTypeScript(ir)];
    expect(code).toContain("export interface GadgetData extends WidgetData {\n  serial: number;\n}");
    expect(code).toContain("export class Gadget extends Widget {");
    expect(code).toContain("    super(ctx, data);");
    expect(code).toContain('import { type FileInput, readChanges, readTree } from "../runtime/files.ts";');
    expect(code).toContain("files?: string | FileInput[]");
    expect(code).toContain("changes?: FileInput[] | Record<string, string | null>");
    expect(code).toContain("helpers?: Array<Widget | { who: Widget; role?: string }>");
    expect(code).toContain("note?: string | undefined");
    // A handle with a number in its id is sent as that number, not as text.
    expect(code).toContain(
      "part: options.part === undefined ? undefined : { widgetId: options.part.widgetId, number: options.part.number }",
    );
    expect(code).toContain("files: options.files === undefined ? undefined : readTree(options.files)");
    expect(code).toContain("changes: options.changes === undefined ? undefined : readChanges(options.changes)");
    expect(code).toContain("(item instanceof Widget ? { who: item.id } : { ...item, who: item.who.id })");
    expect(code).toContain("query: { since }");
  });

  test("Python: the same, in Python's terms", () => {
    const [[, code] = ["", ""]] = [...emitPython(ir)];
    expect(code).toContain("class Gadget(Widget):");
    expect(code).toContain('        super().__init__(ctx, data)\n        self.serial: int = data["serial"]');
    expect(code).toContain("from ..runtime.files import ChangesInput, TreeInput, read_changes, read_tree");
    expect(code).toContain("files: TreeInput | None = None");
    expect(code).toContain("helpers: list[Widget | dict[str, Any]] | None = None");
    expect(code).toContain('"files": None if files is None else read_tree(files)');
    expect(code).toContain('"changes": None if changes is None else read_changes(changes)');
    expect(code).toContain('"part": None if part is None else {"widgetId": part.widget_id, "number": part.number}');
    expect(code).toContain('({"who": item.id} if isinstance(item, (Widget,)) else');
    expect(code).toContain('query={"since": since}');
  });
});
