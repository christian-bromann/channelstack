// Runs after the static build: every link on every page to somewhere on the site (the page's own
// text, and the nav and footer around it) must reach a page or a file, and its #anchor an element
// there. The API reference is generated, so this is also what catches a generated link to a
// heading that isn't there.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".html") ? [path] : [];
  });
const pageFor = (route) => {
  const base = route.replace(/\/$/, "") || "/index";
  return [join(dist, `${base}.html`), join(dist, base, "index.html")].find((file) => existsSync(file));
};
const ids = new Map();
const idsOf = (file) => {
  if (!ids.has(file))
    ids.set(file, new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(file);
};

const broken = [];
for (const file of walk(dist)) {
  const html = readFileSync(file, "utf8");
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (/^([a-z]+:|\/\/)/.test(href)) continue;
    const [path = "", hash] = href.split("#");
    // A file (`/llms.txt`, `/docs/guide/ci.md`, an asset) must exist; a page must be built.
    const isFile = /\.[a-z0-9]+$/i.test(path);
    const target = !path
      ? file
      : isFile
        ? existsSync(join(dist, path))
          ? join(dist, path)
          : undefined
        : pageFor(path);
    if (!target) broken.push(`${relative(dist, file)}: nothing at ${href}`);
    else if (hash && !isFile && !idsOf(target).has(decodeURIComponent(hash)))
      broken.push(`${relative(dist, file)}: no #${hash} on ${path || "the page"}`);
  }
}
if (broken.length > 0) {
  console.error(`check-links: ${broken.length} broken links\n${broken.join("\n")}`);
  process.exit(1);
}
console.log("check-links: every link on the site reaches its page, file and heading");
