// Renders og/og.html to the link-preview image, the icons and the README logo, with a local Chrome.
// Run it by hand after changing og/og.html; the PNGs are committed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((path) => path && existsSync(path));
if (!chrome) throw new Error("Chrome not found. Set CHROME_PATH.");

function shot(hash, width, height, out, { transparent = false, scale = 1 } = {}) {
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--hide-scrollbars",
      `--force-device-scale-factor=${scale}`,
      "--allow-file-access-from-files",
      "--virtual-time-budget=3000",
      ...(transparent ? ["--default-background-color=00000000"] : []),
      `--window-size=${width},${height}`,
      `--screenshot=${root}${out}`,
      `file://${root}og/og.html${hash}`,
    ],
    { stdio: "ignore" },
  );
  console.log(`wrote ${out}`);
}

mkdirSync(`${root}src/assets`, { recursive: true });
// Imported by src/components/Seo.tsx, so its URL carries a content hash: a changed image gets a
// new URL, and link previews that cache by URL pick it up.
shot("", 1200, 630, "src/assets/og.png");
shot("#icon-180", 180, 180, "public/apple-touch-icon.png");
shot("#icon-192", 192, 192, "public/icon-192.png");
shot("#icon-512", 512, 512, "public/icon-512.png");
shot("#favicon-32", 32, 32, "public/favicon-32.png", { transparent: true });
// The banner at the top of the repository README, at 2x for sharp rendering. It carries its own
// dark background, so it reads the same on light and dark pages.
mkdirSync(`${root}../.github/assets`, { recursive: true });
shot("#banner", 1280, 340, "../.github/assets/banner.png", { transparent: true, scale: 2 });
