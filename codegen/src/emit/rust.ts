import type { Ir, IrField, IrMethod, IrParam, IrResource, IrType, IrWait } from "../ir.ts";
import { BANNER, IrIndex, pathParts, snakeCase } from "./shared.ts";

const OUT = "sdks/rust/src/generated/mod.rs";

/** Words Rust reserves. A name that collides is a raw identifier (`r#type`); the few that can't be get a `_`. */
const KEYWORDS = new Set(
  "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try gen".split(
    " ",
  ),
);
const NOT_RAW = new Set(["self", "Self", "crate", "super"]);
/** Names a handle already has from its traits or the generator: a field named so gets a `_`. */
const TAKEN = new Set(["data", "ctx", "wrap", "wrap_opt", "wrap_vec", "from_wire", "close", "seen"]);

/** A Rust identifier for an IR name: snake_case, and never a keyword. */
function ident(name: string): string {
  const snake = snakeCase(name);
  if (NOT_RAW.has(snake)) return `${snake}_`;
  return KEYWORDS.has(snake) ? `r#${snake}` : snake;
}

/** `createUser` → `CreateUser`, for builder types. */
const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** A Rust string literal. */
const str = (value: string) => JSON.stringify(value);

/** The Rust SDK's generated half: handles with typed getters, a builder per method, waits, and calls by name. */
export function emitRust(ir: Ir): Map<string, string> {
  const index = new IrIndex(ir);
  const namedTypes = new Map(ir.types.map((type) => [type.name, type.type]));

  /** The resources a resource is a kind of, itself first. */
  const chain = (resource: IrResource): IrResource[] =>
    resource.extends === undefined ? [resource] : [resource, ...chain(index.resource(resource.extends))];
  /** A resource's methods, its own and those it has from what it extends (its own win). */
  const methodsOf = (resource: IrResource): IrMethod[] => {
    const seen = new Set<string>();
    return chain(resource).flatMap((link) =>
      link.methods.filter((method) => !seen.has(method.name) && seen.add(method.name)),
    );
  };
  const waitsOf = (resource: IrResource): IrWait[] => {
    const seen = new Set<string>();
    return chain(resource).flatMap((link) =>
      (link.waits ?? []).filter((wait) => !seen.has(wait.name) && seen.add(wait.name)),
    );
  };
  /** The resource that holds a method, for its run function's name. */
  const owner = (resource: IrResource, name: string): IrResource =>
    chain(resource).find((link) => link.methods.some((method) => method.name === name)) ?? resource;
  const runName = (resource: IrResource, method: IrMethod) =>
    `run_${snakeCase(owner(resource, method.name).name)}_${snakeCase(method.name)}`;

  const resolve = (type: IrType): IrType =>
    type.kind === "named" ? resolve(namedTypes.get(type.name) ?? { kind: "unknown" }) : type;

  // --- How an argument goes on the wire ---------------------------------------------------------

  /** A closure (`&|v: &Value| …`) that encodes one value of this type, or `None` when it goes as it is. */
  const encoder = (type: IrType): string | undefined => {
    switch (type.kind) {
      case "ref":
        return `&|v: &Value| enc::ref_ids(v, &[${index.refIdFields(type.resources).map(str).join(", ")}])`;
      case "duration":
        return "&|v: &Value| enc::duration(v)";
      case "array": {
        const item = encoder(type.items);
        return item === undefined && !type.oneOrMany
          ? undefined
          : `&|v: &Value| enc::array(v, ${type.oneOrMany === true}, ${item ?? "&|v: &Value| enc::plain(v)"})`;
      }
      case "object": {
        const fields = type.fields.flatMap((field) => {
          const encode = encoder(field.type);
          return encode === undefined ? [] : [`(${str(field.name)}, ${encode})`];
        });
        const short = type.fields.find((field) => field.name === type.shorthand);
        if (fields.length === 0 && !short) return undefined;
        const shorthand = short
          ? `Some((${str(short.name)}, ${encoder(short.type) ?? "&|v: &Value| enc::plain(v)"}))`
          : "None";
        return `&|v: &Value| enc::object(v, ${shorthand}, &[${fields.join(", ")}])`;
      }
      case "nullable":
        return encoder(type.type);
      default:
        return undefined;
    }
  };

  /** The expression that puts a parameter's value (the local of its name) on the wire. */
  const encode = (param: IrParam): string => {
    const local = `p_${snakeCase(param.name)}`;
    const inner = encoder(param.type) ?? "&|v: &Value| enc::plain(v)";
    const value =
      param.shorthand === undefined
        ? encoder(param.type) === undefined
          ? `${local}.clone()`
          : `(${inner})(&${local})?`
        : `enc::shorthand(&${local}, ${str(param.shorthand)}, ${inner})?`;
    return param.credential === undefined ? value : `enc::credential_or(${value}, ${str(param.credential)}, &raw)`;
  };

  /** A method's run function: its request from the handle's data, its arguments and its options. */
  const runFunction = (resource: IrResource, m: IrMethod): string[] => {
    const params = [...m.args, ...m.options];
    const path = pathParts(m)
      .map((part) => {
        if (typeof part === "string") return part.replaceAll("{", "{{").replaceAll("}", "}}");
        return part.from === "session" ? "{}" : "{}";
      })
      .join("");
    const pathArgs = pathParts(m)
      .filter((part) => typeof part !== "string")
      .map((part) =>
        part.from === "session" ? "encode_segment(ctx.session()?)" : `path_value(&me[${str(part.field ?? "")}])?`,
      );
    const entries = (where: "body" | "query") => params.filter((param) => param.in === where);
    const map = (where: "body" | "query") =>
      entries(where).length === 0
        ? ["None"]
        : [
            `Some({ let mut wire = Map::new(); ${entries(where)
              .map((param) => `wire.insert(${str(param.name)}.into(), ${encode(param)});`)
              .join(" ")} wire })`,
          ];
    const needsRaw = params.some((param) => param.credential !== undefined);
    return [
      "",
      `fn ${runName(resource, m)}<'a>(ctx: &'a Ctx, me: &'a Value, args: Vec<Value>, options: Map<String, Value>) -> BoxFuture<'a, Result<Value>> {`,
      "    Box::pin(async move {",
      `        let _ = (&me, &options);`,
      "        let mut args = args.into_iter();",
      ...m.args.map((arg) => `        let p_${snakeCase(arg.name)} = args.next().unwrap_or(Value::Null);`),
      ...m.options.map(
        (option) =>
          `        let p_${snakeCase(option.name)} = options.get(${str(option.name)}).cloned().unwrap_or(Value::Null);`,
      ),
      ...(needsRaw
        ? [
            `        let raw: Map<String, Value> = [${params
              .map((param) => `(${str(param.name)}.to_owned(), p_${snakeCase(param.name)}.clone())`)
              .join(", ")}].into_iter().collect();`,
          ]
        : []),
      `        let path = format!(${str(path)}${pathArgs.map((arg) => `, ${arg}`).join("")});`,
      `        send(ctx, ${str(m.http.verb)}, path, ${map("body")}, ${map("query")}, ${m.onceQuiet === true}, &[${(m.retryWhile ?? []).map(str).join(", ")}]).await`,
      "    })",
      "}",
    ];
  };

  // --- What a method returns --------------------------------------------------------------------

  /** The Rust type a method returns, and the function that turns the wire data into it. */
  const returned = (type: IrType | null): { type: string; wrap: string } => {
    if (type === null) return { type: "()", wrap: "as_unit" };
    if (type.kind === "resource") return { type: type.name, wrap: `${type.name}::wrap` };
    if (type.kind === "nullable" && type.type.kind === "resource")
      return { type: `Option<${type.type.name}>`, wrap: `${type.type.name}::wrap_opt` };
    if (type.kind === "array" && type.items.kind === "resource")
      return { type: `Vec<${type.items.name}>`, wrap: `${type.items.name}::wrap_vec` };
    return { type: "Value", wrap: "as_value" };
  };

  /** A getter for a field of a handle's data, typed where the type is plain. */
  const getter = (field: IrField): string[] => {
    const name = TAKEN.has(snakeCase(field.name)) ? `${snakeCase(field.name)}_` : ident(field.name);
    const key = str(field.name);
    const nullable = field.type.kind === "nullable";
    const type = resolve(nullable && field.type.kind === "nullable" ? field.type.type : field.type);
    const maybe = field.optional || nullable;
    const scalar = (rust: string, read: string, fallback: string) =>
      maybe
        ? [`    pub fn ${name}(&self) -> Option<${rust}> {`, `        self.data.get(${key}).and_then(${read})`, "    }"]
        : [
            `    pub fn ${name}(&self) -> ${rust} {`,
            `        self.data.get(${key}).and_then(${read}).unwrap_or(${fallback})`,
            "    }",
          ];
    const doc = `    /// \`${field.name}\`.`;
    switch (type.kind) {
      case "string":
      case "enum":
        return [doc, ...scalar("String", "|v| v.as_str().map(str::to_owned)", "String::new()")];
      case "literal":
        return typeof type.value === "boolean"
          ? [doc, ...scalar("bool", "Value::as_bool", "false")]
          : [doc, ...scalar("String", "|v| v.as_str().map(str::to_owned)", "String::new()")];
      case "boolean":
        return [doc, ...scalar("bool", "Value::as_bool", "false")];
      case "number":
      case "duration":
        return [doc, ...scalar("f64", "Value::as_f64", "0.0")];
      case "integer":
        return [doc, ...scalar("i64", "Value::as_i64", "0")];
      case "resource":
        return maybe
          ? [
              doc,
              `    pub fn ${name}(&self) -> Option<${type.name}> {`,
              `        self.data.get(${key}).filter(|v| !v.is_null()).map(|v| ${type.name}::from_wire(&self.ctx, v.clone()))`,
              "    }",
            ]
          : [
              doc,
              `    pub fn ${name}(&self) -> ${type.name} {`,
              `        ${type.name}::from_wire(&self.ctx, self.data.get(${key}).cloned().unwrap_or(Value::Null))`,
              "    }",
            ];
      case "array":
        if (type.items.kind === "resource") {
          return [
            doc,
            `    pub fn ${name}(&self) -> Vec<${type.items.name}> {`,
            `        self.data.get(${key}).and_then(Value::as_array).map(|items| items.iter().map(|v| ${type.items.name}::from_wire(&self.ctx, v.clone())).collect()).unwrap_or_default()`,
            "    }",
          ];
        }
        return [
          doc,
          `    pub fn ${name}(&self) -> &Value {`,
          `        self.data.get(${key}).unwrap_or(&Value::Null)`,
          "    }",
        ];
      default:
        return [
          doc,
          `    pub fn ${name}(&self) -> &Value {`,
          `        self.data.get(${key}).unwrap_or(&Value::Null)`,
          "    }",
        ];
    }
  };

  // --- Handles ----------------------------------------------------------------------------------

  const builderName = (resource: IrResource, name: string) => `${resource.name}${pascal(name)}`;

  /** A method on a handle, and the builder that sets its options. */
  const method = (resource: IrResource, m: IrMethod): { inherent: string[]; builder: string[] } => {
    const { type, wrap } = returned(m.returns);
    const args = m.args.map((arg) => `${ident(arg.name)}: impl IntoArg`);
    const call = `Call::new(&self.ctx, &self.data, vec![${m.args.map((arg) => `${ident(arg.name)}.into_arg()`).join(", ")}], ${runName(resource, m)}, ${wrap})`;
    const doc = `    /// ${m.summary}.${m.stability === "experimental" ? " Experimental." : ""}`;
    if (m.options.length === 0) {
      return {
        inherent: [
          "",
          doc,
          `    pub fn ${ident(m.name)}(&self${args.map((arg) => `, ${arg}`).join("")}) -> Call<${type}> {`,
          `        ${call}`,
          "    }",
        ],
        builder: [],
      };
    }
    const builder = builderName(resource, m.name);
    return {
      inherent: [
        "",
        doc,
        `    pub fn ${ident(m.name)}(&self${args.map((arg) => `, ${arg}`).join("")}) -> ${builder} {`,
        `        ${builder}(${call})`,
        "    }",
      ],
      builder: [
        "",
        `/// The options of [\`${resource.name}::${ident(m.name)}\`]: set the ones you need, then \`.send().await\` (or \`.await\`).`,
        `pub struct ${builder}(Call<${type}>);`,
        "",
        `impl ${builder} {`,
        ...m.options.flatMap((option) => [
          `    /// \`${option.name}\`.`,
          `    pub fn ${ident(option.name)}(self, value: impl IntoArg) -> Self {`,
          `        Self(self.0.option(${str(option.name)}, value))`,
          "    }",
        ]),
        "    /// Send the request.",
        `    pub async fn send(self) -> Result<${type}> {`,
        "        self.0.send().await",
        "    }",
        "}",
        "",
        `impl IntoFuture for ${builder} {`,
        `    type Output = Result<${type}>;`,
        `    type IntoFuture = BoxFuture<'static, Result<${type}>>;`,
        "    fn into_future(self) -> Self::IntoFuture {",
        "        self.0.into_future()",
        "    }",
        "}",
      ],
    };
  };

  /** A wait on a handle (`thread.wait_for_reply()`), and the builder that sets its options. */
  const waitMethod = (resource: IrResource, w: IrWait): { inherent: string[]; builder: string[] } => {
    const read = methodsOf(resource).find((m) => m.name === w.read);
    if (!read) throw new Error(`${resource.name}.${w.name} reads ${w.read}, which it doesn't have`);
    const builder = builderName(resource, w.name);
    const { type, wrap } = returned(w.item);
    const filters = w.filter ? read.options.map((option) => option.name) : [];
    const options = [
      ...filters,
      ...(w.from ? ["from"] : []),
      ...(w.text ? [w.text] : []),
      "timeout",
      ...(w.mode === "latest" ? ["quietFor"] : []),
    ];
    const wanted = w.mode === "until" && w.in;
    const readCall = `${runName(resource, read)}(&ctx, &me, vec![], filters.clone())`;
    const conditions = [
      ...(w.from ? [`from_matches(item.get(${str(w.from)}).unwrap_or(&Value::Null), &from)`] : []),
      ...(w.text ? [`text_matches(item.get(${str(w.text)}).and_then(Value::as_str).unwrap_or(""), &text)`] : []),
    ];
    const what = w.from
      ? `&match &from { Value::Null => ${str(w.what)}.to_owned(), Value::String(name) => format!("{} from {}", ${str(w.what)}, name), other => format!("{} from {}", ${str(w.what)}, other.get("name").and_then(Value::as_str).unwrap_or("")) }`
      : `${str(w.what)}`;
    let body: string[];
    if (w.mode === "next") {
      const key =
        filters.length > 0 ? `&format!("${w.name}:{}", serde_json::Value::Object(filters.clone()))` : str(w.name);
      const turn = w.turn
        ? `Some(&|item: &Value| item.get(${str(w.turn.field)}).and_then(Value::as_str) == Some(${str(w.turn.value)}))`
        : "None";
      body = [
        `        let item = wait_for_next(&seen, ${key}, || ${readCall}, |item: &Value| ${conditions.join(" && ") || "{ let _ = item; true }"}, ${turn}, ${what}, &timeout).await?;`,
        `        ${wrap}(&ctx, item)`,
      ];
    } else if (w.mode === "latest") {
      body = [
        `        let item = latest_once_quiet(|| ${readCall}, |item: &Value| ${conditions.join(" && ") || "{ let _ = item; true }"}, || ctx.quiet(), ${what}, &timeout, &quiet_for).await?;`,
        `        ${wrap}(&ctx, item)`,
      ];
    } else if (wanted) {
      const value = w.field === undefined ? "&value" : `value.get(${str(w.field)}).unwrap_or(&Value::Null)`;
      body = [
        "        let values = match &wanted { Value::Array(values) => values.clone(), one => vec![one.clone()] };",
        `        let value = wait_for(${str(w.what)}, &timeout, || { let values = &values; let read = ${readCall}; async move { let value = read.await?; Ok(values.contains(${value}).then(|| value.clone())) } }).await?;`,
        `        ${wrap}(&ctx, value)`,
      ];
    } else {
      const pending = `[${(w.not ?? []).map(str).join(", ")}].contains(&value.get(${str(w.field ?? "")}).and_then(Value::as_str).unwrap_or(""))`;
      body = [
        `        let value = wait_for(${str(w.what)}, &timeout, || { let read = ${readCall}; async move { let value = read.await?; Ok((!${pending}).then_some(value)) } }).await?;`,
        `        ${wrap}(&ctx, value)`,
      ];
    }
    return {
      inherent: [
        "",
        `    /// Wait for ${w.what}. Set its options on what this returns, then \`.send().await\` (or \`.await\`).`,
        `    pub fn ${ident(w.name)}(&self${wanted ? ", wanted: impl IntoArg" : ""}) -> ${builder} {`,
        `        ${builder} { ctx: self.ctx.clone(), me: self.data.clone(), seen: self.seen.clone(), ${wanted ? "wanted: wanted.into_arg(), " : ""}options: Map::new() }`,
        "    }",
      ],
      builder: [
        "",
        `/// The options of [\`${resource.name}::${ident(w.name)}\`].`,
        `pub struct ${builder} { ctx: Ctx, me: Value, seen: Seen, ${wanted ? "wanted: Value, " : ""}options: Map<String, Value> }`,
        "",
        `impl ${builder} {`,
        ...options.flatMap((option) => [
          `    /// \`${option}\`.`,
          `    pub fn ${ident(option === "from" ? "from" : option)}(mut self, value: impl IntoArg) -> Self {`,
          `        self.options.insert(${str(option)}.into(), value.into_arg());`,
          "        self",
          "    }",
        ]),
        "    /// Wait.",
        `    pub async fn send(self) -> Result<${type}> {`,
        `        let Self { ctx, me, seen, ${wanted ? "wanted, " : ""}options } = self;`,
        "        let _ = &seen;",
        `        let filters: Map<String, Value> = options.iter().filter(|(name, _)| [${filters.map(str).join(", ")}].contains(&name.as_str())).map(|(name, value)| (name.clone(), value.clone())).collect();`,
        `        let timeout = options.get("timeout").cloned().unwrap_or_else(|| Value::from("10s"));`,
        ...(w.mode === "latest"
          ? [`        let quiet_for = options.get("quietFor").cloned().unwrap_or_else(|| Value::from("750ms"));`]
          : []),
        ...(w.from ? [`        let from = options.get("from").cloned().unwrap_or(Value::Null);`] : []),
        ...(w.text ? [`        let text = options.get(${str(w.text)}).cloned().unwrap_or(Value::Null);`] : []),
        ...body,
        "    }",
        "}",
        "",
        `impl IntoFuture for ${builder} {`,
        `    type Output = Result<${type}>;`,
        `    type IntoFuture = BoxFuture<'static, Result<${type}>>;`,
        "    fn into_future(self) -> Self::IntoFuture {",
        "        Box::pin(self.send())",
        "    }",
        "}",
      ],
    };
  };

  const handle = (resource: IrResource): string[] => {
    const isRoot = resource.name === ir.root;
    const sessionId = resource.scope === "session" ? resource.idFields?.[0] : undefined;
    const fields = chain(resource)
      .flatMap((link) => link.fields)
      .filter((field, at, all) => all.findIndex((other) => other.name === field.name) === at);
    const methods = methodsOf(resource).map((m) => method(resource, m));
    const waits = waitsOf(resource).map((w) => waitMethod(resource, w));
    const parents = chain(resource).slice(1);
    return [
      "",
      `/// A handle: \`${resource.name}\`.`,
      "#[derive(Clone)]",
      `pub struct ${resource.name} {`,
      "    ctx: Ctx,",
      "    data: Value,",
      "    seen: Seen,",
      "}",
      "",
      `impl Handle for ${resource.name} {`,
      "    fn data(&self) -> &Value {",
      "        &self.data",
      "    }",
      "    fn ctx(&self) -> &Ctx {",
      "        &self.ctx",
      "    }",
      "}",
      "",
      `impl ${resource.name} {`,
      "    #[doc(hidden)]",
      "    pub fn from_wire(ctx: &Ctx, data: Value) -> Self {",
      sessionId
        ? `        let ctx = ctx.in_session(data.get(${str(sessionId)}).and_then(Value::as_str).map(str::to_owned));`
        : "        let ctx = ctx.clone();",
      "        Self { ctx, data, seen: Seen::default() }",
      "    }",
      "    #[doc(hidden)]",
      "    pub fn wrap(ctx: &Ctx, data: Value) -> Result<Self> {",
      "        Ok(Self::from_wire(ctx, data))",
      "    }",
      "    #[doc(hidden)]",
      "    pub fn wrap_opt(ctx: &Ctx, data: Value) -> Result<Option<Self>> {",
      "        Ok((!data.is_null()).then(|| Self::from_wire(ctx, data)))",
      "    }",
      "    #[doc(hidden)]",
      "    pub fn wrap_vec(ctx: &Ctx, data: Value) -> Result<Vec<Self>> {",
      "        Ok(data.as_array().map(|items| items.iter().map(|item| Self::from_wire(ctx, item.clone())).collect()).unwrap_or_default())",
      "    }",
      ...parents.flatMap((parent) => [
        `    /// This handle as the \`${parent.name}\` it is a kind of.`,
        `    pub fn as_${snakeCase(parent.name)}(&self) -> ${parent.name} {`,
        `        ${parent.name}::from_wire(&self.ctx, self.data.clone())`,
        "    }",
      ]),
      ...(isRoot ? [] : fields.flatMap(getter)),
      ...methods.flatMap((m) => m.inherent),
      ...waits.flatMap((w) => w.inherent),
      ...(isRoot
        ? [
            "",
            "    /// Close the client: a server it started is stopped.",
            "    pub async fn close(self) {",
            '        let started = self.ctx.started.lock().expect("the client\'s server").take();',
            "        if let Some(started) = started {",
            "            started.stop().await;",
            "        }",
            "    }",
          ]
        : []),
      "}",
      ...methods.flatMap((m) => m.builder),
      ...waits.flatMap((w) => w.builder),
    ];
  };

  // --- Calls by name ----------------------------------------------------------------------------

  /** How a call by name returns: a handle of this resource, or data. */
  const dynReturn = (type: IrType | null): string => {
    if (type?.kind === "resource") {
      const sessionId =
        index.resource(type.name).scope === "session" ? index.resource(type.name).idFields?.[0] : undefined;
      const ctx = sessionId
        ? `target.ctx.in_session(data.get(${str(sessionId)}).and_then(Value::as_str).map(str::to_owned))`
        : "target.ctx.clone()";
      return `Dyn { resource: Some(${str(type.name)}), ctx: ${ctx}, data }`;
    }
    if (type?.kind === "nullable" && type.type.kind === "resource") {
      return `Dyn { resource: (!data.is_null()).then_some(${str(type.type.name)}), ctx: target.ctx.clone(), data }`;
    }
    return "Dyn { resource: None, ctx: target.ctx.clone(), data }";
  };

  const dispatch = [
    "",
    "/// Call a method by its name in the API (`createUser`) on any handle: what the smoke runner does.",
    "/// Handles in `args` and `options` are their data; they are sent by their ids.",
    "pub async fn call_by_name(target: &Dyn, method: &str, args: Vec<Value>, options: Map<String, Value>) -> Result<Dyn> {",
    '    let resource = target.resource.ok_or_else(|| Error::Invalid(format!("{method}: not a handle")))?;',
    "    let data = match (resource, method) {",
    ...ir.resources.flatMap((resource) =>
      methodsOf(resource).map(
        (m) =>
          `        (${str(resource.name)}, ${str(m.name)}) => ${runName(resource, m)}(&target.ctx, &target.data, args, options).await?,`,
      ),
    ),
    '        _ => return Err(Error::Invalid(format!("{resource}.{method}: no such method"))),',
    "    };",
    "    Ok(match (resource, method) {",
    ...ir.resources.flatMap((resource) =>
      methodsOf(resource)
        .filter((m) => dynReturn(m.returns).includes("Some("))
        .map((m) => `        (${str(resource.name)}, ${str(m.name)}) => ${dynReturn(m.returns)},`),
    ),
    "        _ => Dyn { resource: None, ctx: target.ctx.clone(), data },",
    "    })",
    "}",
    "",
    "/// The resource a handle's field holds, when it holds one (`SlackMessage.thread` → `SlackThread`).",
    "pub fn field_resource(resource: &str, field: &str) -> Option<&'static str> {",
    "    match (resource, field) {",
    ...ir.resources.flatMap((resource) =>
      chain(resource)
        .flatMap((link) => link.fields)
        .flatMap((field) => {
          const type = field.type.kind === "nullable" ? field.type.type : field.type;
          return type.kind === "resource"
            ? [`        (${str(resource.name)}, ${str(field.name)}) => Some(${str(type.name)}),`]
            : [];
        })
        .filter((line, at, all) => all.indexOf(line) === at),
    ),
    "        _ => None,",
    "    }",
    "}",
  ];

  const root = index.resource(ir.root);
  const lines = [
    `// ${BANNER}`,
    "#![allow(clippy::all, dead_code, unused_imports, unused_variables, unused_mut, non_snake_case)]",
    "",
    "use std::future::IntoFuture;",
    "",
    "use serde_json::{Map, Value};",
    "",
    "use crate::runtime::client::{as_unit, as_value, enc, encode_segment, path_value, send, BoxFuture, Call, Ctx, Dyn, Handle, IntoArg};",
    "use crate::runtime::error::{Error, Result};",
    "use crate::runtime::launcher::{launch, Mode};",
    "use crate::runtime::wait::{from_matches, latest_once_quiet, text_matches, wait_for, wait_for_next};",
    "",
    "/// The server version this SDK was generated for. It checks the server's major version on connect.",
    `pub const VERSION: &str = ${str(ir.version)};`,
    `const BASE_PATH: &str = ${str(ir.basePath)};`,
    "",
    "/// How far each `wait_for_…` of a handle has looked, so the next one waits for something new.",
    "type Seen = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, usize>>>;",
    "",
    "/// The protocol's error codes, as `Error::Api { code, .. }` carries them.",
    "pub mod codes {",
    ...ir.errors.map((code) => `    pub const ${code.toUpperCase()}: &str = ${str(code)};`),
    "}",
    ...ir.resources.flatMap((resource) =>
      methodsOf(resource)
        .filter((m) => owner(resource, m.name) === resource)
        .flatMap((m) => runFunction(resource, m)),
    ),
    ...ir.resources.flatMap(handle),
    ...dispatch,
    "",
    "/// Attach to a running channelstack server, or start one (`Mode`), and answer the client.",
    `pub async fn connect(mode: Mode) -> Result<${root.name}> {`,
    "    connect_with(mode, None, None).await",
    "}",
    "",
    "/// `connect`, to a server at this URL, with this token: otherwise they come from the environment or `server.json`.",
    `pub async fn connect_with(mode: Mode, server: Option<&str>, token: Option<&str>) -> Result<${root.name}> {`,
    "    let mut connection = launch(mode, server, token).await?;",
    "    let started = std::sync::Arc::new(std::sync::Mutex::new(connection.started.take()));",
    "    let transport = std::sync::Arc::new(crate::runtime::transport::Transport::new(&connection.url, &connection.token, BASE_PATH)?);",
    "    let ctx = Ctx { transport, session: None, started };",
    '    let status = match ctx.transport.request("GET", "/status", None, None).await {',
    "        Ok(status) => status,",
    `        Err(error) => { ${root.name}::from_wire(&ctx, Value::Null).close().await; return Err(error); }`,
    "    };",
    '    let version = status.get("version").and_then(Value::as_str).unwrap_or("").to_owned();',
    "    if version.split('.').next() != VERSION.split('.').next() {",
    `        ${root.name}::from_wire(&ctx, Value::Null).close().await;`,
    '        return Err(Error::Launch(format!("The channelstack server is version {version}, but this SDK was generated for {VERSION}")));',
    "    }",
    `    Ok(${root.name}::from_wire(&ctx, Value::Null))`,
    "}",
    "",
  ];
  return new Map([[OUT, lines.join("\n")]]);
}
