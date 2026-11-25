import { join } from "node:path";

import { writePrivateFile } from "../home/index.ts";

/**
 * Keeps Node's proxy-aware `fetch` in a Node agent that loads undici 7 or later.
 *
 * With `NODE_USE_ENV_PROXY=1`, Node 24's own `fetch` sends requests through `HTTPS_PROXY`. But
 * importing the `undici` package (Bolt does, through `@slack/socket-mode`) installs a plain Agent as
 * the global dispatcher, which replaces Node's proxy-aware one, so the agent's calls go straight to
 * slack.com. undici installs its dispatcher only where it can define its global: this preload
 * defines that global first, empty and fixed, so undici keeps its Agent to itself and Node's `fetch`
 * keeps the proxy. It changes nothing else, and runs only in the agent's environment
 * (`NODE_OPTIONS`, printed by `channelstack env --proxy`).
 */
const NODE_PRELOAD = `// channelstack proxy mode (written by \`channelstack start --proxy\`): keep Node's proxy-aware fetch.
// undici 7+ installs its own global dispatcher when it is imported, which replaces the one
// NODE_USE_ENV_PROXY sets up. Defining undici's global first, fixed and empty, keeps Node's.
Object.defineProperty(globalThis, Symbol.for("undici.globalDispatcher.2"), {
  value: undefined,
  writable: false,
  configurable: false,
});
`;

/** Write the preload to `<home>/proxy/node-env-proxy.mjs` and answer its path. */
export function writeNodePreload(home: string): string {
  const path = join(home, "proxy", "node-env-proxy.mjs");
  writePrivateFile(path, NODE_PRELOAD);
  return path;
}

/** `NODE_OPTIONS` that loads the preload: the path quoted, since a home directory may have spaces. */
export function nodeOptions(preload: string): string {
  return `--import=${JSON.stringify(preload)}`;
}
