/**
 * Exit check 0.3: packaging works. Packs the `channelstack` package and this machine's server
 * package with `npm pack`, installs them into an empty project, checks `npx channelstack --version`,
 * and runs the TypeScript smoke scenarios against what was installed.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import ts from "typescript";

import rootPackage from "../package.json" with { type: "json" };
import sdkPackage from "../sdks/typescript/package.json" with { type: "json" };
import serverPackage from "../server/package.json" with { type: "json" };
import { ROOT, toJson } from "./lib/generate.ts";
import {
  binaryPath,
  hostTarget,
  NPM_DIR,
  platformPackageDir,
  platformPackageName,
  type TargetKey,
  TARGETS,
} from "./lib/packages.ts";
import { capture, run } from "./lib/process.ts";
import { startBinary } from "./lib/server.ts";
import { runSmoke } from "./smoke.ts";

/**
 * The type names the contract exports as `channelstack`, but the test framework's own, which
 * `channelstack/vitest` has, and `SlackInjectedFault`, the SDK's `SlackFault` (#37).
 */
function contractTypeNames(): string[] {
  const elsewhere = new Set([
    "ChannelstackFixture",
    "ChannelstackIntegrationOptions",
    "ChannelstackMatchers",
    "TextOptions",
    "SlackInjectedFault",
  ]);
  const contract = join(ROOT, "api", "index.d.ts");
  const program = ts.createProgram([contract], { noEmit: true });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(contract) as ts.SourceFile);
  if (!module) throw new Error(`Can't read ${contract}`);
  return checker
    .getExportsOfModule(module)
    .map((symbol) => symbol.name)
    .filter((name) => !elsewhere.has(name))
    .sort();
}

const host = hostTarget();
if (!existsSync(binaryPath(host)) || !existsSync(join(ROOT, "sdks/typescript/dist/sdks/typescript/client.js"))) {
  throw new Error("Nothing to pack. Run `pnpm build` first.");
}
if (sdkPackage.version !== serverPackage.version) {
  throw new Error(
    `The SDK (${sdkPackage.version}) and the server (${serverPackage.version}) must have the same version`,
  );
}

// The published `channelstack` package: the SDK, the bin shim, and every platform's server as an optional dependency.
const main = join(NPM_DIR, "channelstack");
rmSync(main, { recursive: true, force: true });
mkdirSync(main, { recursive: true });
for (const entry of ["bin", "dist"])
  cpSync(join(ROOT, "sdks/typescript", entry), join(main, entry), { recursive: true });
for (const entry of ["LICENSE", "README.md"]) cpSync(join(ROOT, entry), join(main, entry));
const { scripts: _scripts, ...manifest } = sdkPackage;
const platforms = Object.keys(TARGETS) as TargetKey[];
writeFileSync(
  join(main, "package.json"),
  toJson({
    ...manifest,
    optionalDependencies: Object.fromEntries(platforms.map((key) => [platformPackageName(key), serverPackage.version])),
  }),
);

const tarballs = mkdtempSync(join(tmpdir(), "channelstack-pack-"));
const pack = (directory: string) => {
  const [packed] = JSON.parse(
    capture("npm", ["pack", "--json", "--pack-destination", tarballs], { cwd: directory }),
  ) as [{ filename: string }];
  return join(tarballs, packed.filename);
};
const mainTarball = pack(main);

// The other platforms' packages aren't published yet, so the registry can't resolve them. Each gets a
// stand-in with the real name, `os` and `cpu` and no binary; npm skips it on this machine, exactly as
// it will skip the real one after a release.
const platformTarballs = Object.fromEntries(
  platforms.map((key) => {
    if (key === host) return [platformPackageName(key), pack(platformPackageDir(key))];
    const standIn = join(tarballs, `stand-in-${key}`);
    mkdirSync(standIn);
    writeFileSync(
      join(standIn, "package.json"),
      toJson({
        name: platformPackageName(key),
        version: serverPackage.version,
        os: [TARGETS[key].os],
        cpu: [TARGETS[key].cpu],
      }),
    );
    return [platformPackageName(key), pack(standIn)];
  }),
);

const project = mkdtempSync(join(tmpdir(), "channelstack-project-"));
try {
  writeFileSync(
    join(project, "package.json"),
    toJson({
      name: "empty-project",
      private: true,
      type: "module",
      dependencies: { channelstack: `file:${mainTarball}`, yaml: rootPackage.devDependencies.yaml },
      overrides: Object.fromEntries(
        Object.entries(platformTarballs).map(([name, tarball]) => [name, `file:${tarball}`]),
      ),
    }),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: project });

  const version = capture("npx", ["--no-install", "channelstack", "--version"], { cwd: project }).trim();
  if (version !== serverPackage.version)
    throw new Error(`npx channelstack --version printed "${version}", expected ${serverPackage.version}`);
  console.log(`npx channelstack --version → ${version}`);

  // Stopping the `channelstack` command must stop the server behind it: the shim forwards the signal,
  // and the server removes its token file on the way out.
  const shim = join(project, "node_modules", ".bin", "channelstack");
  const serverFile = join(project, "server.json");
  const viaShim = await startBinary({
    bin: shim,
    args: ["--no-portless", "--port", "0", "--server-file", serverFile],
    serverFile,
  });
  const status = await fetch(`${viaShim.url}/_channelstack/status`, {
    headers: { authorization: `Bearer ${viaShim.token}` },
  });
  if (!status.ok) throw new Error(`The server started through the shim answered ${status.status}`);
  await viaShim.stop();
  if (existsSync(serverFile))
    throw new Error("SIGTERM to the channelstack command left the server's token file behind");
  const stillUp = await fetch(`${viaShim.url}/_channelstack/status`).then(
    () => true,
    () => false,
  );
  if (stillUp) throw new Error("SIGTERM to the channelstack command left the server running");
  console.log("SIGTERM to the channelstack command stopped the server and removed its token file");

  // The package root is the client with its types, as `channelstack/client` is: tests import their
  // handle types from it (`import type { SlackUser } from "channelstack"`).
  const sameModule = capture(
    "node",
    [
      "--input-type=module",
      "-e",
      'const root = await import("channelstack"); const client = await import("channelstack/client"); console.log(typeof root.connect === "function" && root.connect === client.connect);',
    ],
    { cwd: project },
  ).trim();
  if (sameModule !== "true") throw new Error('`import "channelstack"` is not the client that `channelstack/client` is');
  // Every type name the contract (`api/index.d.ts`) gives `channelstack`, imported from the installed package.
  const names = contractTypeNames();
  writeFileSync(
    join(project, "types.ts"),
    [
      `import type { ${names.join(", ")} } from "channelstack";`,
      'import { connect } from "channelstack";',
      `export type Every = [${names.join(", ")}];`,
      // The contract's generic types take their type arguments here too.
      'export const narrowed = (delivery: Delivery<"app_mention">): "app_mention" => delivery.type;',
      "export const inspected = (slack: SlackFixture): Inspectable<SlackDelivery> => slack;",
      "export const open = connect;",
      "",
    ].join("\n"),
  );
  run(
    join(ROOT, "node_modules", ".bin", "tsc"),
    ["--noEmit", "--strict", "--skipLibCheck", "--module", "nodenext", "--moduleResolution", "nodenext", "types.ts"],
    { cwd: project },
  );
  console.log(
    `import type { … } from "channelstack": the contract's ${names.length} type names type-check against the installed package`,
  );

  // The scenario runner is copied in, so its `channelstack/client` import resolves to the installed package.
  const runner = join(project, "run.ts");
  cpSync(join(ROOT, "scenarios/runners/typescript/run.ts"), runner);
  // The one module the runner has beside it: the rule for what a recording leaves out.
  cpSync(join(ROOT, "scenarios/runners/typescript/secrets.ts"), join(project, "secrets.ts"));
  const installed = join(
    project,
    "node_modules",
    ...platformPackageName(host).split("/"),
    "bin",
    basename(binaryPath(host)),
  );
  await runSmoke({ sdks: ["typescript"], bin: installed, typescriptRunner: runner });
  console.log("packaging: installed package passed the TypeScript smoke scenarios");
} finally {
  rmSync(project, { recursive: true, force: true });
  rmSync(tarballs, { recursive: true, force: true });
}
