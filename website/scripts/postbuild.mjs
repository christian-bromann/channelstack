// Runs after the static build: writes sitemap.xml and the _headers file for Cloudflare.
// The Content-Security-Policy allows only our own files, plus the exact inline scripts the
// prerenderer emits (by hash), so no 'unsafe-inline' is needed.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SITE = "https://channelstack.dev";
const dist = new URL("../dist/", import.meta.url).pathname;

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith(".html") ? [path] : [];
    }),
  );
  return files.flat();
}

const pages = await htmlFiles(dist);
const hashes = new Set();
const urls = [];

for (const file of pages) {
  const html = await readFile(file, "utf8");
  for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\ssrc=/.test(attrs) || !body) continue;
    hashes.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
  }
  if (/<style[\s>]/.test(html) || /\sstyle="/.test(html)) {
    throw new Error(`${relative(dist, file)} contains inline styles, which the Content-Security-Policy blocks`);
  }
  const route = "/" + relative(dist, file).replace(/\.html$/, "").replace(/(^|\/)index$/, "");
  if (route !== "/404") urls.push(SITE + (route === "/" ? "/" : route));
}

urls.sort();
await writeFile(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}\n</urlset>\n`,
);

const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].sort().join(" ")}`,
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

await writeFile(
  join(dist, "_headers"),
  `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()

/assets/*
  Cache-Control: public, max-age=31536000, immutable

https://:host.workers.dev/*
  X-Robots-Tag: noindex
`,
);

console.log(`postbuild: ${urls.length} URLs in sitemap.xml, ${hashes.size} inline script hashes in _headers`);
