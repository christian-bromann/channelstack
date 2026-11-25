// Runs after the static build: every link inside a docs page to another page of the site must
// reach a page, and its #anchor a heading there. The API reference is generated, so this is also
// what catches a generated link to a heading that isn't there.
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
for (const file of [join(dist, "docs.html"), ...walk(join(dist, "docs"))]) {
  const html = readFileSync(file, "utf8");
  const article = html.slice(html.indexOf("<article"), html.indexOf("</article>"));
  for (const [, href] of article.matchAll(/href="([^"]+)"/g)) {
    if (/^[a-z]+:/.test(href)) continue;
    const [path, hash] = href.split("#");
    const target = path ? pageFor(path) : file;
    if (!target) broken.push(`${relative(dist, file)}: no page at ${href}`);
    else if (hash && !idsOf(target).has(decodeURIComponent(hash)))
      broken.push(`${relative(dist, file)}: no #${hash} on ${path || "the page"}`);
  }
}
if (broken.length > 0) {
  console.error(`check-links: ${broken.length} broken links\n${broken.join("\n")}`);
  process.exit(1);
}
console.log("check-links: every docs link reaches its page and heading");
