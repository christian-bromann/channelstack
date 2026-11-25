// Checks that the Python samples and docs examples parse. The repository's `pnpm typecheck` checks them
// against the API with pyright: see samples/python/README.md.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const dirs = ["../samples/python/", "../examples/python/"].map((dir) => new URL(dir, import.meta.url).pathname);
const files = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".py"))
    .map((name) => dir + name),
);
const program = "import ast, sys\nfor path in sys.argv[1:]:\n    ast.parse(open(path, encoding='utf-8').read(), path)";
execFileSync("python3", ["-I", "-c", program, ...files], { stdio: "inherit" });
console.log(`python samples and examples: ${files.length} files parse`);
