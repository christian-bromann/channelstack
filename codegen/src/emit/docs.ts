/**
 * The API reference on channelstack.dev, generated from the IR like the SDKs, so it can't drift
 * from them: every handle with its fields, methods and waits, each call shown in every SDK's
 * language with the names that SDK's own emitter gives it, and every error code.
 *
 * The pages land in website/docs/reference/api/, and `pnpm sdk:check` fails when they're stale.
 */
import { headingIds, slugify } from "../../../website/plugins/slug.ts";
import type { Ir, IrMethod, IrParam, IrResource, IrType, IrWait } from "../ir.ts";
import { pythonName } from "./python.ts";
import { rustErrorConst, rustName } from "./rust.ts";
import { BANNER, errorClassName, IrIndex } from "./shared.ts";
import { typeScriptTypes } from "./typescript.ts";

const DIR = "website/docs/reference/api";
const ROUTE = "/docs/reference/api";

/**
 * The pages, in sidebar order. The client's and the errors page sit in "Test API"; the platforms'
 * in "Platform APIs", each linked to its guide under /docs/platforms.
 */
const PAGES = [
  { slug: "client", title: "Client and sessions", prefix: undefined, fixture: undefined, order: 2 },
  { slug: "slack", title: "Slack API", prefix: "Slack", fixture: "slack", order: 1 },
  { slug: "github", title: "GitHub API", prefix: "GitHub", fixture: "github", order: 2 },
  { slug: "linear", title: "Linear API", prefix: "Linear", fixture: "linear", order: 3 },
  { slug: "notion", title: "Notion API", prefix: "Notion", fixture: "notion", order: 4 },
] as const;
const ERRORS_ORDER = 4;
const PLATFORM_SECTION = "Platform APIs";
const TEST_SECTION = "Test API";

type Page = (typeof PAGES)[number];

/** `echo` is channelstack's own test platform: it isn't documented. */
const INTERNAL = "Echo";

/** Prose from the routes, safe in MDX: braces and `<` outside code spans are escaped. */
const prose = (text: string) =>
  text
    .split(/(`[^`]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/[{}]/g, "\\$&").replace(/</g, "&lt;")))
    .join("");

/** A table cell: a pipe would end it, even inside code. */
const cell = (text: string) => text.replace(/\|/g, "\\|");

const code = (text: string) => `\`${text}\``;

/** A value in an example call: an expression, or the variable named like the parameter. */
interface Value {
  name: string;
  literal?: string;
  /** A handle: Rust passes it by reference. */
  handle?: boolean;
}

/** A name in Python and Rust: one when they agree, both when a keyword makes them differ (`from_`, `r#type`). */
const otherNames = (name: string) => {
  const python = pythonName(name);
  const rust = rustName(name);
  return python === rust ? code(python) : `${code(python)} · ${code(rust)}`;
};

/** Rust: a handle by reference, anything else as it is. */
const rustValue = (value: Value) => value.literal ?? `${value.handle ? "&" : ""}${rustName(value.name)}`;

/** One tab of a code group. */
const tab = (title: string, lang: string, line: string) => [`\`\`\`${lang} title="${title}"`, line, "```", ""];

export function emitDocs(ir: Ir): Map<string, string> {
  const index = new IrIndex(ir);
  const { typeOf } = typeScriptTypes(index);
  const ts = (type: IrType) => typeOf(type, "public");

  const pageOf = (name: string): Page | undefined => {
    if (name.startsWith(INTERNAL)) return undefined;
    return PAGES.find((page) => page.prefix !== undefined && name.startsWith(page.prefix)) ?? PAGES[0];
  };

  /** The variable a value of this type goes in, in the examples: `SlackUser` → `user`, `SlackFixture` → `slack`. */
  const local = (name: string): string => {
    const page = pageOf(name);
    if (page?.prefix !== undefined && name === `${page.prefix}Fixture`) return page.fixture ?? "fixture";
    const bare = page?.prefix !== undefined ? name.slice(page.prefix.length) : name;
    return bare.charAt(0).toLowerCase() + bare.slice(1);
  };

  const resultName = (type: IrType | null, receiver: string): string | undefined => {
    if (type === null) return undefined;
    const name =
      type.kind === "resource" || type.kind === "named"
        ? local(type.name)
        : type.kind === "nullable"
          ? (resultName(type.type, receiver) ?? "result")
          : type.kind === "array"
            ? "items"
            : "result";
    return name === receiver ? "updated" : name;
  };

  // Every heading's anchor, in page order, with the ids the site gives them: `refresh`, `refresh-1`, …
  const anchors = new Map<string, string>();
  const ids = new Map<string, (heading: string) => string>();
  const anchor = (page: Page, key: string, heading: string): string => {
    const idOf = ids.get(page.slug) ?? headingIds();
    ids.set(page.slug, idOf);
    const id = idOf(heading);
    anchors.set(key, `${ROUTE}/${page.slug}#${id}`);
    return id;
  };

  /** A type, linked to its section when it's a handle or a named type. */
  const typeLink = (type: IrType | null): string => {
    if (type === null) return "nothing";
    const inner = type.kind === "nullable" ? type.type : type;
    const target = inner.kind === "resource" || inner.kind === "named" ? anchors.get(`type:${inner.name}`) : undefined;
    const shown = code(ts(type));
    return target ? `[${shown}](${target})` : shown;
  };

  // Codes most methods can return say nothing about one method: the pages name them once, up top.
  const allMethods = ir.resources.flatMap((resource) => resource.methods);
  const everywhere = new Set(
    ir.errors.filter(
      (errorCode) => allMethods.filter((method) => method.errors.includes(errorCode)).length > allMethods.length / 2,
    ),
  );
  const errorsPath = `${ROUTE}/errors`;
  const errorLink = (errorCode: string) => `[${code(errorCode)}](${errorsPath}#${slugify(errorCode)})`;

  /** The same call in each SDK's language. */
  const calls = (
    receiver: string,
    name: string,
    args: readonly Value[],
    options: readonly Value[],
    wanted: string | undefined,
  ) => {
    // The result may not shadow a variable the call uses.
    const used = new Set([
      receiver,
      ...[...args, ...options].filter((value) => value.literal === undefined).map((value) => value.name),
    ]);
    const result = wanted !== undefined && used.has(wanted) ? "result" : wanted;
    const tsValue = (value: Value) => value.literal ?? value.name;
    const tsOption = (value: Value) => (value.literal === undefined ? value.name : `${value.name}: ${value.literal}`);
    const pyValue = (value: Value) => value.literal ?? pythonName(value.name);
    const tsArgs = [...args.map(tsValue), ...(options.length > 0 ? [`{ ${options.map(tsOption).join(", ")} }`] : [])];
    const pyArgs = [...args.map(pyValue), ...options.map((option) => `${pythonName(option.name)}=${pyValue(option)}`)];
    const tsCall = `await ${receiver}.${name}(${tsArgs.join(", ")})`;
    const pyCall = `await ${pythonName(receiver)}.${pythonName(name)}(${pyArgs.join(", ")})`;
    // Rust: arguments to the method, then a setter per option, and the builder is awaited.
    const rsCall = `${rustName(receiver)}.${rustName(name)}(${args.map(rustValue).join(", ")})${options.map((option) => `.${rustName(option.name)}(${rustValue(option)})`).join("")}.await?`;
    return [
      "<CodeGroup>",
      "",
      ...tab("TypeScript", "ts", result ? `const ${result} = ${tsCall};` : `${tsCall};`),
      ...tab("Python", "python", result ? `${pythonName(result)} = ${pyCall}` : pyCall),
      ...tab("Rust", "rust", result ? `let ${rustName(result)} = ${rsCall};` : `${rsCall};`),
      "</CodeGroup>",
      "",
    ];
  };

  /** A string argument is written as one, `"…"`; anything else as the variable it would be in. */
  const exampleValue = (param: IrParam): Value => ({
    name: param.name,
    ...(param.shorthand !== undefined || param.type.kind === "string" ? { literal: '"…"' } : {}),
    ...(param.type.kind === "ref" ? { handle: true } : {}),
  });

  /** The options a call shows: the required ones, or the first when none is. The table lists them all. */
  const shownOptions = (options: readonly IrParam[]) => {
    const required = options.filter((option) => !option.optional);
    return (required.length > 0 ? required : options.slice(0, 1)).map(exampleValue);
  };

  const waitCalls = (
    receiver: string,
    wait: IrWait,
    args: readonly Value[],
    filter: readonly Value[],
    options: readonly Value[],
    result: string | undefined,
  ) => {
    if (filter.length === 0) return calls(receiver, wait.name, args, options, result);
    // TypeScript: the read's filter is its own object, before the wait's options.
    const object = (values: readonly Value[]) =>
      `{ ${values.map((value) => (value.literal === undefined ? value.name : `${value.name}: ${value.literal}`)).join(", ")} }`;
    const tsArgs = [
      ...args.map((value) => value.literal ?? value.name),
      object(filter),
      ...(options.length > 0 ? [object(options)] : []),
    ];
    const pyArgs = [
      ...args.map((value) => value.literal ?? pythonName(value.name)),
      ...[...filter, ...options].map((value) => `${pythonName(value.name)}=${value.literal ?? pythonName(value.name)}`),
    ];
    // Rust: the wait is a builder; the filter and the options are its setters.
    const rsCall = `${rustName(receiver)}.${rustName(wait.name)}(${args.map(rustValue).join(", ")})${[...filter, ...options].map((value) => `.${rustName(value.name)}(${rustValue(value)})`).join("")}.await?`;
    return [
      "<CodeGroup>",
      "",
      ...tab("TypeScript", "ts", `const ${result} = await ${receiver}.${wait.name}(${tsArgs.join(", ")});`),
      ...tab(
        "Python",
        "python",
        `${pythonName(result ?? "result")} = await ${pythonName(receiver)}.${pythonName(wait.name)}(${pyArgs.join(", ")})`,
      ),
      ...tab("Rust", "rust", `let ${rustName(result ?? "result")} = ${rsCall};`),
      "</CodeGroup>",
      "",
    ];
  };

  const paramRow = (param: { name: string; type: string; required: boolean; note?: string }) =>
    `| ${code(param.name)} | ${otherNames(param.name)} | ${cell(code(param.type))} | ${param.required ? "yes" : "no"} | ${cell(param.note ?? "")} |`;

  const paramTable = (rows: Array<{ name: string; type: string; required: boolean; note?: string }>) =>
    rows.length === 0
      ? []
      : ["| Parameter | Python · Rust | Type | Required | |", "|---|---|---|---|---|", ...rows.map(paramRow), ""];

  const paramOf = (param: IrParam, positional: boolean) => ({
    name: param.name,
    type: `${param.shorthand === undefined ? "" : "string | "}${ts(param.type)}`,
    required: !param.optional,
    note: [
      positional ? "positional" : "option",
      ...(param.credential ? [`read from \`${param.credential}\` when left out`] : []),
    ].join("; "),
  });

  const liveNote = (method: IrMethod): string[] => {
    if (!method.live) return [];
    if ("unsupported" in method.live) {
      return [`**Live:** refused with ${errorLink("unsupported_in_live")}: ${prose(method.live.unsupported)}.`, ""];
    }
    // channelstack doesn't drive either piece live yet, so these are refused whatever the run has.
    const [piece, issue] =
      method.live.requires === "browser"
        ? [
            "the browser actor",
            "doesn't do this yet ([#47](https://github.com/christian-bromann/channelstack/issues/47))",
          ]
        : [
            "proxy mode",
            "doesn't read the app's calls back live yet ([#24](https://github.com/christian-bromann/channelstack/issues/24))",
          ];
    return [
      `**Live:** needs ${piece}: ${prose(method.live.reason)}. ${piece.charAt(0).toUpperCase()}${piece.slice(1)} ${issue}, so for now the call is refused with ${errorLink("action_requires")} and the test is skipped.`,
      "",
    ];
  };

  const methodSection = (page: Page, resource: IrResource, method: IrMethod): string[] => {
    const receiver = local(resource.name);
    const heading = `${method.name}()`;
    anchor(page, `method:${resource.name}.${method.name}`, heading);
    const specific = method.errors.filter((errorCode) => !everywhere.has(errorCode));
    const result = resultName(method.returns, receiver);
    return [
      `### ${heading}`,
      "",
      `${prose(method.summary)}.`,
      "",
      ...calls(
        receiver,
        method.name,
        method.args.filter((arg) => !arg.optional).map(exampleValue),
        shownOptions(method.options),
        method.returns === null ? undefined : result,
      ),
      ...paramTable([
        ...method.args.map((arg) => paramOf(arg, true)),
        ...method.options.map((option) => paramOf(option, false)),
      ]),
      `**Returns** ${typeLink(method.returns)}.${method.onceQuiet ? " It reads once the app is quiet." : ""}${method.retryWhile ? ` While refused with ${method.retryWhile.map(errorLink).join(" or ")}, it tries again until the wait's timeout.` : ""}${method.dispose ? " Disposing the handle calls it." : ""}`,
      "",
      ...(specific.length > 0 ? [`**Errors** ${specific.map(errorLink).join(", ")}.`, ""] : []),
      ...liveNote(method),
    ];
  };

  const waitSection = (page: Page, resource: IrResource, wait: IrWait): string[] => {
    const receiver = local(resource.name);
    const heading = `${wait.name}()`;
    anchor(page, `method:${resource.name}.${wait.name}`, heading);
    const item = wait.item.kind === "resource" ? index.resource(wait.item.name) : undefined;
    const fromField = item?.fields.find((field) => field.name === wait.from);
    const read = resource.methods.find((method) => method.name === wait.read);
    const filters = wait.filter && read ? read.options : [];
    const what =
      wait.mode === "next"
        ? `Waits for the next ${wait.what.replace(/^an? /, "")} after the last one this handle returned`
        : wait.mode === "latest"
          ? `The latest ${wait.what.replace(/^an? /, "")}, once the app is quiet. Waits for at least one`
          : `Waits for ${wait.what}`;
    // A realistic call: who it's from, the filter's first option. The table lists every option.
    const shown: Value[] = fromField ? [{ name: "from", literal: '"my-agent"' }] : [];
    const result = resultName(wait.item, receiver);
    const filterArgs = filters.length > 0 ? shownOptions(filters) : [];
    return [
      `### ${heading}`,
      "",
      `${what}: it polls \`${wait.read}()\` and never sleeps longer than it must.`,
      "",
      ...waitCalls(
        receiver,
        wait,
        wait.mode === "until" && wait.in ? [{ name: "wanted" }] : [],
        filterArgs,
        shown,
        result,
      ),
      ...paramTable([
        ...(wait.mode === "until" && wait.in
          ? [{ name: "wanted", type: `${ts(wait.item)} | Array<${ts(wait.item)}>`, required: true, note: "positional" }]
          : []),
        ...filters.map((option) => ({ ...paramOf(option, false), note: "filter" })),
        ...(fromField
          ? [{ name: "from", type: `${ts(fromField.type)} | string`, required: false, note: "a handle, or a name" }]
          : []),
        ...(wait.text
          ? [{ name: wait.text, type: "string | RegExp", required: false, note: "contains, or matches" }]
          : []),
        { name: "timeout", type: "Duration", required: false, note: "default 10s" },
        ...(wait.mode === "latest"
          ? [{ name: "quietFor", type: "Duration", required: false, note: "default 750ms" }]
          : []),
      ]),
      `**Returns** ${typeLink(wait.item)}. When the time is up, it fails with what it was waiting for.`,
      "",
    ];
  };

  const fieldTable = (fields: ReadonlyArray<{ name: string; type: IrType; optional: boolean }>) =>
    fields.length === 0
      ? []
      : [
          "| Field | Python · Rust | Type |",
          "|---|---|---|",
          ...fields.map(
            (field) =>
              `| ${code(field.name)} | ${otherNames(field.name)} | ${cell(code(`${ts(field.type)}${field.optional ? " | undefined" : ""}`))} |`,
          ),
          "",
        ];

  /** Who hands out this handle: its factories and the methods that return it. */
  const madeBy = (name: string): string[] => {
    const sources = ir.resources.flatMap((resource) =>
      resource.methods
        .filter((method) => {
          const returned = method.returns?.kind === "nullable" ? method.returns.type : method.returns;
          return returned?.kind === "resource" && returned.name === name;
        })
        .map((method) => `${resource.name}.${method.name}`),
    );
    return sources;
  };

  const resourceSection = (page: Page, resource: IrResource): string[] => {
    const made = madeBy(resource.name).slice(0, 4);
    const methods = resource.methods.map((method) => methodSection(page, resource, method));
    const waits = (resource.waits ?? []).map((wait) => waitSection(page, resource, wait));
    return [
      `## ${resource.name}`,
      "",
      ...(resource.extends
        ? [
            `A kind of ${typeLink({ kind: "resource", name: resource.extends })}: it has all its fields and methods.`,
            "",
          ]
        : []),
      ...(made.length > 0
        ? [
            `Returned by ${made.map((source) => `[${code(`${source}()`)}](${anchors.get(`method:${source}`) ?? "#"})`).join(", ")}.`,
            "",
          ]
        : []),
      ...fieldTable(resource.fields),
      ...methods.flat(),
      ...waits.flat(),
    ];
  };

  const typeSection = (page: Page, type: Ir["types"][number]): string[] => {
    anchor(page, `type-heading:${type.name}`, type.name);
    const body =
      type.type.kind === "object"
        ? fieldTable(type.type.fields)
        : ["```ts", `type ${type.name} = ${ts(type.type)};`, "```", ""];
    return [`### ${type.name}`, "", ...body];
  };

  // Anchors first: a link may point down the page, or to another page. Headings are planned in page order.
  const plan = PAGES.map((page) => ({
    page,
    resources: ir.resources.filter((resource) => pageOf(resource.name) === page),
    types: ir.types.filter((type) => pageOf(type.name) === page),
  }));
  // A dry run gives every heading its id in page order, the same order the pages are written in
  // below, so a link can point down the page or to another page.
  const alias = (from: string, to: string) => anchors.set(from, anchors.get(to) ?? "#");
  for (const { page, resources, types } of plan) {
    for (const resource of resources) {
      anchor(page, `resource:${resource.name}`, resource.name);
      alias(`type:${resource.name}`, `resource:${resource.name}`);
      for (const method of resource.methods) anchor(page, `method:${resource.name}.${method.name}`, `${method.name}()`);
      for (const wait of resource.waits ?? []) anchor(page, `method:${resource.name}.${wait.name}`, `${wait.name}()`);
    }
    if (types.length > 0) anchor(page, "types", "Types");
    for (const type of types) {
      anchor(page, `type-heading:${type.name}`, type.name);
      alias(`type:${type.name}`, `type-heading:${type.name}`);
    }
  }
  ids.clear();

  /** The "Types" heading, given its id first like every other heading. */
  const typesHeading = (page: Page) => {
    anchor(page, "types", "Types");
    return "## Types";
  };

  const files = new Map<string, string>();
  for (const { page, resources, types } of plan) {
    const intro =
      page.prefix === undefined
        ? "The client you connect with, and the session each test runs in. Every handle on the platform pages is reached from here."
        : `Every handle of the ${page.prefix} fake: the \`${page.fixture}\` fixture, the people and objects a test creates on it, and what they read and wait for. How to test a ${page.prefix} app or agent, step by step, is in the [${page.prefix} guide](/docs/platforms/${page.slug}).`;
    const body = [
      ...resources.flatMap((resource) => {
        anchor(page, `resource:${resource.name}`, resource.name);
        return resourceSection(page, resource);
      }),
      ...(types.length > 0
        ? [
            typesHeading(page),
            "",
            "Plain values the handles return and take.",
            "",
            ...types.flatMap((type) => typeSection(page, type)),
          ]
        : []),
    ];
    files.set(
      `${DIR}/${page.slug}.mdx`,
      [
        "---",
        `title: ${JSON.stringify(page.title)}`,
        `order: ${page.order}`,
        `section: ${JSON.stringify(page.prefix === undefined ? TEST_SECTION : PLATFORM_SECTION)}`,
        `description: ${JSON.stringify(page.prefix === undefined ? "The channelstack client and sessions: every method, in every SDK's language." : `Every handle, method and wait of the ${page.prefix} fake, in every SDK's language.`)}`,
        "---",
        "",
        `{/* ${BANNER} */}`,
        "",
        `# ${page.title}`,
        "",
        intro,
        "",
        `Each call is shown in every SDK's language, with its required options (the table under it lists them all). Arguments go first; options are TypeScript's trailing object, Python's keyword arguments and Rust's builder setters. The variable names are the ones the calls return elsewhere on these pages, so \`user\` is a ${code(page.prefix ? `${page.prefix}User` : "user")} handle.`,
        "",
        `Besides the errors listed with each method, most methods can fail with ${[...everywhere].sort().map(errorLink).join(", ")}: a bad request, a closed session, or live mode refusing or misconfigured.`,
        "",
        ...body,
      ].join("\n"),
    );
  }

  files.set(`${DIR}/errors.mdx`, errorsPage(ir, anchors, everywhere));
  return files;
}

/** Every error code: what channelstack's own mean, and where the fakes' come from. */
function errorsPage(ir: Ir, anchors: ReadonlyMap<string, string>, everywhere: ReadonlySet<string>): string {
  const raisedBy = (errorCode: string) =>
    ir.resources.flatMap((resource) =>
      resource.methods
        .filter((method) => method.errors.includes(errorCode))
        .map((method) => ({ resource: resource.name, method: method.name })),
    );
  const link = ({ resource, method }: { resource: string; method: string }) => {
    const target = anchors.get(`method:${resource}.${method}`);
    const shown = code(`${resource}.${method}()`);
    return target ? `[${shown}](${target})` : shown;
  };
  const own = ir.errors.filter((errorCode) => errorCode in ir.errorDocs);
  // A platform code that only Echo's resources raise is internal, like Echo.
  const platforms = ir.errors.filter(
    (errorCode) =>
      !(errorCode in ir.errorDocs) && raisedBy(errorCode).some(({ resource }) => !resource.startsWith(INTERNAL)),
  );
  const classLine = (errorCode: string) =>
    `SDK class: ${code(errorClassName(errorCode))} in TypeScript and Python, a subclass of ${code("ChannelstackError")}. Rust: ${code("Error::Api { code, .. }")} with ${code("code")} equal to ${code(`codes::${rustErrorConst(errorCode)}`)}.`;
  const section = (errorCode: string, lines: string[]) => [`### ${errorCode}`, "", ...lines, ""];
  const where = (errorCode: string) => {
    if (everywhere.has(errorCode)) return "Most methods can return it.";
    const methods = raisedBy(errorCode).filter(({ resource }) => !resource.startsWith(INTERNAL));
    if (methods.length === 0) return "";
    const shown = methods.slice(0, 12).map(link).join(", ");
    return `Raised by ${shown}${methods.length > 12 ? `, and ${methods.length - 12} more` : ""}.`;
  };
  const platformOf = (errorCode: string) => {
    const names = new Set(
      raisedBy(errorCode).flatMap(({ resource }) =>
        PAGES.filter((page) => page.prefix !== undefined && resource.startsWith(page.prefix)).map(
          (page) => page.prefix,
        ),
      ),
    );
    const list = [...names];
    return list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
  };
  return [
    "---",
    'title: "Errors"',
    `order: ${ERRORS_ORDER}`,
    `section: ${JSON.stringify(TEST_SECTION)}`,
    "description: \"Every error code the control API returns: channelstack's own, and the platforms' codes the fakes refuse with.\"",
    "---",
    "",
    `{/* ${BANNER} */}`,
    "",
    "# Errors",
    "",
    "A refused call raises an error with a stable `code`, the HTTP status, a message and sometimes `data`. TypeScript and Python have one class per code, so a test can catch exactly the refusal it expects. In Rust a refusal is `Error::Api { code, status, message, data }`, and `channelstack::codes` has each code as a constant to compare `code` with. channelstack's own codes are below; after them, the codes the fakes refuse with where the real platform refuses the same request.",
    "",
    "## channelstack's codes",
    "",
    ...own.flatMap((errorCode) => {
      const docs = ir.errorDocs[errorCode];
      return section(errorCode, [
        `HTTP ${docs?.status}. ${prose(docs?.description ?? "")}`,
        "",
        classLine(errorCode),
        "",
        where(errorCode),
      ]);
    }),
    "## Platform codes",
    "",
    "The fakes refuse what the real platform refuses. Where the platform has its own error code, such as Slack's `not_in_channel`, the fake refuses with it. Where the platform answers with an HTTP status and no code of its own, such as GitHub's 403 and 422, the code is channelstack's name for the refusal (`forbidden`, `validation_failed`).",
    "",
    ...platforms.flatMap((errorCode) => {
      const platform = platformOf(errorCode);
      return section(errorCode, [
        `The ${platform ? `${platform} ${platform.includes(" and ") ? "fakes refuse" : "fake refuses"}` : "fakes refuse"} with it where the platform refuses the same request.`,
        "",
        classLine(errorCode),
        "",
        where(errorCode),
      ]);
    }),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}
