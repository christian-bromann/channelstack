/**
 * Runs under Bun (`bun scripts/bun-compile.ts <entry> <target> <outfile>`), for `build-binary.ts`:
 * `bun build --compile` through `Bun.build`, with one plugin. `<entry> --bundle <dir>` builds the
 * same way without `--compile`, for a test that runs what the binary would hold under `bun`.
 *
 * It minifies whitespace only. WebdriverIO tells a browser from an element by its scope
 * function's name (`scopeType.name === "Browser"` in `@wdio/utils`), and Bun's identifier and
 * syntax minifiers rename or drop it (`keepNames` doesn't keep it): the browser actor's session
 * then has no capabilities and fails to start (#49).
 *
 * The plugin makes WebdriverIO bundle (the browser actor, `core/browser`). It loads its protocol
 * driver and its Node half with computed imports (`import(options.automationProtocol || "webdriver")`,
 * `import(nodeModule)`), which a bundler can't follow, so the binary would miss them. The plugin
 * rewrites those to literal imports at build time; `node_modules` stays untouched. Until WebdriverIO
 * makes them literal itself.
 */

interface BunPlugin {
  name: string;
  setup(build: {
    onLoad(
      options: { filter: RegExp },
      load: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>,
    ): void;
  }): void;
}
declare const Bun: {
  build(options: {
    entrypoints: string[];
    compile?: { target: string; outfile: string };
    outdir?: string;
    target?: "bun";
    minify: { whitespace: boolean };
    plugins: BunPlugin[];
  }): Promise<{ success: boolean; logs: unknown[] }>;
  file(path: string): { text(): Promise<string> };
};

/** `import(/* @vite-ignore *\/ <protocol>)` in WebdriverIO: literal for the WebDriver protocol, as it is for anything else. */
const PROTOCOL_IMPORT = /await import\(\s*\/\* @vite-ignore \*\/\s*([^()]*?)\s*\)/g;

const literalImports: BunPlugin = {
  name: "webdriverio-literal-imports",
  setup(build) {
    build.onLoad({ filter: /[\\/]webdriverio[\\/]build[\\/]node\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const contents = source.replace(
        PROTOCOL_IMPORT,
        (_, protocol: string) =>
          `await ((protocol) => !protocol || protocol === "webdriver" ? import("webdriver") : import(protocol))(${protocol.replace(/\s*\|\|\s*"webdriver"$/, "")})`,
      );
      if (contents === source) throw new Error(`webdriverio-literal-imports: nothing to rewrite in ${path}`);
      return { contents, loader: "js" };
    });
    build.onLoad({ filter: /[\\/]@wdio[\\/]utils[\\/]build[\\/]index\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const contents = source.replace(/await import\(nodeModule\)/g, 'await import("./node.js")');
      if (contents === source) throw new Error(`webdriverio-literal-imports: nothing to rewrite in ${path}`);
      return { contents, loader: "js" };
    });
  },
};

const [entry, target, outfile] = process.argv.slice(2);
if (!entry || !target || !outfile) {
  throw new Error("Usage: bun scripts/bun-compile.ts <entry> <target> <outfile> | <entry> --bundle <dir>");
}
const options = { entrypoints: [entry], minify: { whitespace: true }, plugins: [literalImports] };
const result = await Bun.build(
  target === "--bundle" ? { ...options, outdir: outfile, target: "bun" } : { ...options, compile: { target, outfile } },
);
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
