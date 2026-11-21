// Renders og/og.html to public/og.png and public/apple-touch-icon.png with a local Chrome.
// Run it by hand after changing og/og.html; the PNGs are committed.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const chrome = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path && existsSync(path));
if (!chrome) throw new Error("Chrome not found. Set CHROME_PATH.");

function shot(hash, width, height, out) {
  execFileSync(chrome, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files", "--virtual-time-budget=3000", `--window-size=${width},${height}`, `--screenshot=${root}public/${out}`, `file://${root}og/og.html${hash}`], { stdio: "ignore" });
  console.log(`wrote public/${out}`);
}

shot("", 1200, 630, "og.png");
shot("#icon", 180, 180, "apple-touch-icon.png");
