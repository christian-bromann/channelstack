/**
 * The API reference on channelstack.dev, generated from the IR like the SDKs, so it can't drift
 * from them: every handle with its fields, methods and waits, each call shown in every SDK's
 * language with the names that SDK's own emitter gives it, and every error code.
 *
 * The pages land in website/docs/reference/api/, and `pnpm sdk:check` fails when they're stale.
 */
import type { Ir, IrMethod, IrParam, IrResource, IrType, IrWait } from "../ir.ts";
import { pythonName } from "./python.ts";
import { BANNER, errorClassName, IrIndex } from "./shared.ts";
import { typeScriptTypes } from "./typescript.ts";

const DIR = "website/docs/reference/api";
const ROUTE = "/docs/reference/api";

/** The pages, in sidebar order after the Vitest plugin's page. */
const PAGES = [
  { slug: "client", title: "Client and sessions", prefix: undefined, fixture: undefined, order: 2 },
  { slug: "slack", title: "Slack API", prefix: "Slack", fixture: "slack", order: 3 },
  { slug: "github", title: "GitHub API", prefix: "GitHub", fixture: "github", order: 4 },
  { slug: "linear", title: "Linear API", prefix: "Linear", fixture: "linear", order: 5 },
  { slug: "notion", title: "Notion API", prefix: "Notion", fixture: "notion", order: 6 },
] as const;
const ERRORS_ORDER = 7;

type Page = (typeof PAGES)[number];

/** `echo` is channelstack's own test platform: it isn't documented. */
const INTERNAL = "Echo";

/** A heading's id, as website/plugins/rehype-headings.ts makes it. The link check in the site's build catches a mismatch. */
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`'"’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

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
}

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

  // Every heading's anchor, in page order, the way the site dedupes them: `refresh`, `refresh-1`, …
  const anchors = new Map<string, string>();
  const seen = new Map<string, Map<string, number>>();
  const anchor = (page: Page, key: string, heading: string): string => {
    const counts = seen.get(page.slug) ?? new Map<string, number>();
    seen.set(page.slug, counts);
    const base = slugify(heading);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
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

  /** The same call in each SDK's language. Rust joins when its emitter does. */
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
    return [
      "<CodeGroup>",
      "",
      '```ts title="TypeScript"',
      result ? `const ${result} = ${tsCall};` : `${tsCall};`,
      "```",
      "",
      '```python title="Python"',
      result ? `${pythonName(result)} = ${pyCall}` : pyCall,
      "```",
      "",
      "</CodeGroup>",
      "",
    ];
  };

  /** A string argument is written as one, `"…"`; anything else as the variable it would be in. */
  const exampleValue = (param: IrParam): Value => ({
    name: param.name,
    ...(param.shorthand !== undefined || param.type.kind === "string" ? { literal: '"…"' } : {}),
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
    return [
      "<CodeGroup>",
      "",
      '```ts title="TypeScript"',
      `const ${result} = await ${receiver}.${wait.name}(${tsArgs.join(", ")});`,
      "```",
      "",
      '```python title="Python"',
      `${pythonName(result ?? "result")} = await ${pythonName(receiver)}.${pythonName(wait.name)}(${pyArgs.join(", ")})`,
      "```",
      "",
      "</CodeGroup>",
      "",
    ];
  };

  const paramRow = (param: { name: string; type: string; required: boolean; note?: string }) =>
    `| ${code(param.name)} | ${code(pythonName(param.name))} | ${cell(code(param.type))} | ${param.required ? "yes" : "no"} | ${cell(param.note ?? "")} |`;

  const paramTable = (rows: Array<{ name: string; type: string; required: boolean; note?: string }>) =>
    rows.length === 0
      ? []
      : ["| Parameter | Python | Type | Required | |", "|---|---|---|---|---|", ...rows.map(paramRow), ""];

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
    const piece = method.live.requires === "browser" ? "the browser actor" : "proxy mode";
    return [
      `**Live:** needs ${piece}: ${prose(method.live.reason)}. Without it, the call is refused with ${errorLink("action_requires")} and the test is skipped.`,
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
      `**Returns** ${typeLink(method.returns)}.${method.onceQuiet ? " It reads once the agent is quiet." : ""}${method.retryWhile ? ` While refused with ${method.retryWhile.map(errorLink).join(" or ")}, it tries again until the wait's timeout.` : ""}${method.dispose ? " Disposing the handle calls it." : ""}`,
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
    const options = [
      ...(fromField ? ["from"] : []),
      ...(wait.text ? [wait.text] : []),
      "timeout",
      ...(wait.mode === "latest" ? ["quietFor"] : []),
    ];
    const what =
      wait.mode === "next"
        ? `Waits for the next ${wait.what.replace(/^an? /, "")} after the last one this handle returned`
        : wait.mode === "latest"
          ? `The latest ${wait.what.replace(/^an? /, "")}, once the agent is quiet. Waits for at least one`
          : `Waits until ${wait.what}`;
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
          "| Field | Python | Type |",
          "|---|---|---|",
          ...fields.map(
            (field) =>
              `| ${code(field.name)} | ${code(pythonName(field.name))} | ${cell(code(`${ts(field.type)}${field.optional ? " | undefined" : ""}`))} |`,
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
  seen.clear();

  const files = new Map<string, string>();
  for (const { page, resources, types } of plan) {
    const intro =
      page.prefix === undefined
        ? "The client you connect with, and the session each test runs in. Every handle on the platform pages is reached from here."
        : `Every handle of the ${page.prefix} fake: the \`${page.fixture}\` fixture, the people and objects a test creates on it, and what they read and wait for.`;
    const body = [
      ...resources.flatMap((resource) => {
        anchor(page, `resource:${resource.name}`, resource.name);
        return resourceSection(page, resource);
      }),
      ...(types.length > 0
        ? [
            (anchor(page, "types", "Types"), "## Types"),
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
        `description: ${JSON.stringify(page.prefix === undefined ? "The channelstack client and sessions: every method, in every SDK's language." : `Every handle, method and wait of the ${page.prefix} fake, in every SDK's language.`)}`,
        "---",
        "",
        `{/* ${BANNER} */}`,
        "",
        `# ${page.title}`,
        "",
        intro,
        "",
        `Each call is shown in every SDK's language, with its required options (the table under it lists them all). Arguments go first; options are TypeScript's trailing object and Python's keyword arguments. The variable names are the ones the calls return elsewhere on these pages, so \`user\` is a ${code(page.prefix ? `${page.prefix}User` : "user")} handle.`,
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
  const platforms = ir.errors.filter((errorCode) => !(errorCode in ir.errorDocs));
  const classLine = (errorCode: string) =>
    `SDK class: ${code(errorClassName(errorCode))} in TypeScript and Python, a subclass of ${code("ChannelstackError")}.`;
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
    return [...names].join(" and ");
  };
  return [
    "---",
    'title: "Errors"',
    `order: ${ERRORS_ORDER}`,
    "description: \"Every error code the control API returns: channelstack's own, and the platforms' codes the fakes refuse with.\"",
    "---",
    "",
    `{/* ${BANNER} */}`,
    "",
    "# Errors",
    "",
    "A refused call raises an error with a stable `code`, the HTTP status, a message and sometimes `data`. Each SDK has one class per code, so a test can catch exactly the refusal it expects. channelstack's own codes are below; after them, the codes the fakes refuse with, which are each platform's own, sent where the real platform sends them.",
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
    "The fakes refuse what the real platform refuses, with the platform's own code.",
    "",
    ...platforms.flatMap((errorCode) => {
      const platform = platformOf(errorCode);
      return section(errorCode, [
        platform ? `${platform}'s own code: the fake sends it where ${platform} would.` : "A platform's own code.",
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
