// Runs after the static build: moves the charset to the front of each page, and writes
// sitemap.xml and the _headers file for Cloudflare.
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

// The headline is the largest paint, so its font is preloaded instead of swapped in late.
const headingFont = (await readdir(join(dist, "assets"))).find((name) => /^familjen-grotesk-latin-wght-normal-.*\.woff2$/.test(name));
if (!headingFont) throw new Error("heading font not found in dist/assets");
const preload = `<link rel="preload" href="/assets/${headingFont}" as="font" type="font/woff2" crossorigin>`;
const hashes = new Set();
const urls = [];

for (const file of pages) {
  let html = await readFile(file, "utf8");
  // The prerenderer puts the page's own tags first in <head>. Browsers only look for the
  // charset in the first 1024 bytes, so move it back to the front.
  const charset = /<meta charset="utf-8"\s*\/?>/i;
  if (!charset.test(html)) throw new Error(`${relative(dist, file)} has no <meta charset>`);
  html = html.replace(charset, "").replace(/<head[^>]*>/, (head) => `${head}<meta charset="utf-8">${preload}`);
  await writeFile(file, html);
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

/logos/*
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'

https://:version.:subdomain.workers.dev/*
  X-Robots-Tag: noindex
`,
);

console.log(`postbuild: ${urls.length} URLs in sitemap.xml, ${hashes.size} inline script hashes in _headers`);
