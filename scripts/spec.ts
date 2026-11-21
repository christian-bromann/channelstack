/**
 * `pnpm spec` regenerates spec/openapi.json and spec/ir.json from the routes.
 * `pnpm spec:check` fails when the committed files differ from what the routes produce.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, specFromRoutes, staleFiles, toJson } from "./lib/generate.ts";

const { openapi, ir } = specFromRoutes();
const files = new Map([
  ["spec/openapi.json", toJson(openapi)],
  ["spec/ir.json", toJson(ir)],
]);

if (process.argv.includes("--check")) {
  const stale = staleFiles(files);
  if (stale.length > 0) {
    console.error(`spec:check failed: ${stale.join(", ")} out of date with the routes. Run \`pnpm spec\`.`);
    process.exit(1);
  }
  console.log("spec:check: spec/openapi.json and spec/ir.json are current");
} else {
  for (const [path, contents] of files) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), contents);
  }
  console.log(`spec: wrote ${[...files.keys()].join(", ")}`);
}
