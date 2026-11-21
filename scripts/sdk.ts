/**
 * `pnpm sdk` regenerates every SDK's generated code from the routes.
 * `pnpm sdk:check` fails when the committed code differs, or when a generated folder holds a file the generator didn't write.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { emitPython } from "../codegen/src/emit/python.ts";
import { emitTypeScript } from "../codegen/src/emit/typescript.ts";
import { filesBelow, ROOT, specFromRoutes, staleFiles } from "./lib/generate.ts";

const GENERATED = ["sdks/typescript/generated", "sdks/python/channelstack/generated"];

const { ir } = specFromRoutes();
const files = new Map([...emitTypeScript(ir), ...emitPython(ir)]);
const strays = () => GENERATED.flatMap(filesBelow).filter((path) => !files.has(path) && !path.includes("__pycache__"));

if (process.argv.includes("--check")) {
  const stale = [...staleFiles(files), ...strays()];
  if (stale.length > 0) {
    console.error(`sdk:check failed: ${stale.join(", ")} out of date with the routes. Run \`pnpm sdk\`.`);
    process.exit(1);
  }
  console.log(`sdk:check: ${files.size} generated files are current`);
} else {
  for (const directory of GENERATED) mkdirSync(join(ROOT, directory), { recursive: true });
  for (const path of strays()) rmSync(join(ROOT, path));
  for (const [path, contents] of files) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), contents);
  }
  console.log(`sdk: wrote ${[...files.keys()].join(", ")}`);
}
