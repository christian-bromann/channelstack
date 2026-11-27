/**
 * `pnpm sdk` regenerates every SDK's generated code from the routes.
 * `pnpm sdk:check` fails when the committed code differs, or when a generated folder holds a file the generator didn't write.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { emitDev } from "../codegen/src/emit/dev.ts";
import { emitDocs } from "../codegen/src/emit/docs.ts";
import { emitPython } from "../codegen/src/emit/python.ts";
import { emitRust } from "../codegen/src/emit/rust.ts";
import { emitTypeScript } from "../codegen/src/emit/typescript.ts";
import { filesBelow, ROOT, specFromRoutes, staleFiles } from "./lib/generate.ts";

// The API reference on the website is generated from the same IR (codegen/src/emit/docs.ts), and
// so are the dev tools' actions (codegen/src/emit/dev.ts).
const GENERATED = [
  "server/src/cli/generated",
  "sdks/typescript/generated",
  "sdks/python/channelstack/generated",
  "sdks/rust/src/generated",
  "website/docs/reference/api",
];

const { ir } = specFromRoutes();
/**
 * Rust is written the way `rustfmt` writes it, so the committed file is what `cargo fmt` keeps. It
 * formats a file in a private directory: half a megabyte through its stdin and stdout can stall.
 */
function rustfmt(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "channelstack-rustfmt-"));
  try {
    const file = join(dir, "generated.rs");
    writeFileSync(file, source);
    const formatted = spawnSync("rustfmt", ["--edition", "2024", file], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (formatted.status !== 0) throw new Error(`rustfmt failed on the generated Rust: ${formatted.stderr}`);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const rust = [...emitRust(ir)].map(([path, contents]) => [path, rustfmt(contents)] as const);
const files = new Map([...emitTypeScript(ir), ...emitPython(ir), ...rust, ...emitDocs(ir), ...emitDev(ir)]);
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
