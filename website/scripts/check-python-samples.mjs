// Checks that the Python samples parse. The repository's `pnpm typecheck` checks them against the API
// with pyright: see samples/python/README.md.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const dir = new URL("../samples/python/", import.meta.url).pathname;
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".py"))
  .map((name) => dir + name);
const program = "import ast, sys\nfor path in sys.argv[1:]:\n    ast.parse(open(path, encoding='utf-8').read(), path)";
execFileSync("python3", ["-I", "-c", program, ...files], { stdio: "inherit" });
console.log(`python samples: ${files.length} files parse`);
