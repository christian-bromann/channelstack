import { describe, expect, test } from "vitest";

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
    expect(code).toContain("f\"/sessions/{quote(session_of(ctx), safe='')}/widgets/{quote(self.id, safe='')}\"");
    expect(code).toContain(
      'body={"label": label, "parent": None if parent is None else parent.id, "mode": mode}, query={"since": since}',
    );
    expect(code).toContain('Session(HandleContext(ctx.transport, data["sessionId"]), data)');
    expect(code).toContain("async def open_session(self) -> Session:");
    expect(code).toContain("class NotFoundError(ChannelstackError):");
  });
});
