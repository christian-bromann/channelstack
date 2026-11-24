import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ProtocolError } from "../errors/index.ts";
import { writePrivateFile } from "../home/index.ts";
import { liveMisconfigured } from "../reality/index.ts";

/**
 * The browser actor (live-mode.md, A3): a real browser driven as a sandbox person, for what a
 * platform lets only its client do (a Slack person's message, a click). WebdriverIO over WebDriver
 * BiDi, headless; the person's signed-in session comes from a saved storage state, so it never
 * signs in itself and never handles a password.
 */

/** One cookie of a saved session, in the shape Playwright's and WebdriverIO's storage states share. */
interface SavedCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  /** Seconds since the epoch; missing or -1 for a cookie of the browser's session. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** A saved signed-in session: its cookies. */
export interface StorageState {
  cookies: SavedCookie[];
}

/** Where `channelstack login` saves a person's session, and where the actor looks without a path. */
export function storageStatePath(home: string, channel: string, person: string): string {
  return join(home, "browser", `${channel}-${person.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`);
}

/**
 * Read a saved session. It must be private to its owner (0600): it signs a person in. Its cookies
 * never leave the server, in a log, an error or an answer.
 */
export function readStorageState(path: string): StorageState {
  let mode: number;
  let state: Partial<StorageState>;
  try {
    mode = statSync(path).mode;
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw liveMisconfigured(
      `No saved browser session at ${path}`,
      missing
        ? "sign the person in once with `channelstack login <channel> --user <name>`"
        : "it isn't a saved browser session",
    );
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw liveMisconfigured(`${path} can be read by others`, "it signs a person in: make it private (chmod 600)");
  }
  return { cookies: Array.isArray(state.cookies) ? state.cookies : [] };
}

export function writeStorageState(path: string, state: StorageState): void {
  writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** The few things the actor needs from a WebdriverIO browser: kept narrow, so tests can stand in for it. */
interface Driver {
  url(url: string): Promise<unknown>;
  getUrl(): Promise<string>;
  setCookies(cookies: SavedCookie[]): Promise<unknown>;
  getCookies(): Promise<SavedCookie[]>;
  $(selector: string): ChainablePromiseElement;
  keys(value: string | string[]): Promise<unknown>;
  pause(ms: number): Promise<unknown>;
  deleteSession(): Promise<unknown>;
}
interface ChainablePromiseElement {
  waitForDisplayed(options: { timeout: number }): Promise<unknown>;
  click(): Promise<unknown>;
  $(selector: string): ChainablePromiseElement;
  isExisting(): Promise<boolean>;
}

export interface BrowserOptions {
  /** Show the window: `channelstack login`, where a person signs in by hand. */
  headed?: boolean;
  /** The only origins it may open, e.g. `https://app.slack.com`. */
  origins: readonly string[];
  /** For tests: how to start a browser. Default: WebdriverIO's `remote`, Chrome over BiDi. */
  launch?: (headed: boolean) => Promise<Driver>;
}

async function launchChrome(headed: boolean): Promise<Driver> {
  const { remote } = await import("webdriverio");
  const args = ["--no-sandbox", "--disable-gpu", "--window-size=1280,900", ...(headed ? [] : ["--headless=new"])];
  return (await remote({
    logLevel: "error",
    capabilities: { browserName: "chrome", webSocketUrl: true, "goog:chromeOptions": { args } },
  })) as unknown as Driver;
}

/** A browser signed in as one person, which opens only the origins it was given. */
export class BrowserActor {
  readonly #driver: Driver;
  readonly #origins: readonly string[];

  private constructor(driver: Driver, origins: readonly string[]) {
    this.#driver = driver;
    this.#origins = origins;
  }

  static async start(options: BrowserOptions & { state?: StorageState }): Promise<BrowserActor> {
    const driver = await (options.launch ?? launchChrome)(options.headed === true);
    const actor = new BrowserActor(driver, options.origins);
    if (options.state && options.state.cookies.length > 0) {
      // A cookie is set from a page of its site: the actor's own origin first, then the session.
      const [home] = options.origins;
      if (home) await driver.url(home);
      await driver.setCookies(options.state.cookies);
    }
    return actor;
  }

  /** Open a page, which must be on one of the actor's origins. */
  async open(url: string): Promise<void> {
    const { origin } = new URL(url);
    if (!this.#origins.includes(origin)) {
      throw new ProtocolError(
        "invalid_argument",
        `The browser actor opens only ${this.#origins.join(", ")}, not ${origin}`,
      );
    }
    await this.#driver.url(url);
  }

  async url(): Promise<string> {
    return this.#driver.getUrl();
  }

  /** The element, once it is shown: what a person waits for before they act on it. */
  async find(selector: string, timeoutMs = 15_000): Promise<ChainablePromiseElement> {
    const element = this.#driver.$(selector);
    await element.waitForDisplayed({ timeout: timeoutMs });
    return element;
  }

  async click(selector: string, timeoutMs?: number): Promise<void> {
    await (await this.find(selector, timeoutMs)).click();
  }

  /** Type into whatever has the focus, the way a person does: key by key. */
  async type(text: string): Promise<void> {
    await this.#driver.keys(text.split(""));
  }

  async press(key: "Enter" | "Tab" | "Escape"): Promise<void> {
    await this.#driver.keys(key === "Enter" ? "" : key === "Tab" ? "" : "");
  }

  async pause(ms: number): Promise<void> {
    await this.#driver.pause(ms);
  }

  /** The session as it is now, to save: the cookies of the actor's origins' sites. */
  async state(domains: readonly string[]): Promise<StorageState> {
    const cookies = await this.#driver.getCookies();
    return { cookies: cookies.filter((cookie) => domains.some((domain) => cookie.domain.endsWith(domain))) };
  }

  async close(): Promise<void> {
    await this.#driver.deleteSession().catch(() => {});
  }
}

/** How a browser is started: Chrome by default, a stand-in in unit tests. */
export type Launch = (headed: boolean) => Promise<Driver>;

/** The actors of the open test sessions: one per person, started on first use, closed with the session. */
export class BrowserActors {
  readonly #actors = new Map<string, Promise<BrowserActor>>();
  readonly #launch: Launch | undefined;

  constructor(launch?: Launch) {
    this.#launch = launch;
  }

  /** The person's actor in this session, started (headless, from their saved session) the first time. */
  for(
    session: string,
    person: string,
    options: { origins: readonly string[]; state: () => StorageState },
  ): Promise<BrowserActor> {
    const key = `${session}\u0000${person}`;
    let actor = this.#actors.get(key);
    if (!actor) {
      actor = (async () =>
        BrowserActor.start({
          origins: options.origins,
          state: options.state(),
          ...(this.#launch ? { launch: this.#launch } : {}),
        }))();
      this.#actors.set(key, actor);
      // A browser that didn't start is tried again next time.
      actor.catch(() => this.#actors.delete(key));
    }
    return actor;
  }

  async close(session: string): Promise<void> {
    for (const [key, actor] of this.#actors) {
      if (!key.startsWith(`${session}\u0000`)) continue;
      this.#actors.delete(key);
      await (await actor.catch(() => undefined))?.close();
    }
  }
}
