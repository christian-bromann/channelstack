import { ProtocolError } from "../errors/index.ts";
import type { NamedIds } from "../ids/index.ts";
import type { Collection, Registry } from "../registry/index.ts";

/**
 * A channel's apps (decision 0027): the built-in `my-agent` and the ones tests make by name.
 * Apps belong to the shared world, as `my-agent` does, not to a session. A name in a session
 * means one of the apps that session used, so what another test makes never changes it.
 */

/** The name of every channel's built-in app. */
export const BUILT_IN_APP = "my-agent";

/** How many apps a channel holds beside the built-in one: they live as long as the server. */
export const APP_LIMIT = 10;

/** 1 to 32 lower-case letters, digits and hyphens, from a letter: one variable name per app name. */
const APP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The app's part of its variables: `code-reviewer` → `CODE_REVIEWER`. */
export function appVariableName(name: string): string {
  return name.toUpperCase().replaceAll("-", "_");
}

/** Where an extra app's events go: `CHANNELSTACK_SLACK_APP_CODER_WEBHOOK_URL`. */
export function appWebhookVariable(driver: string, name: string): string {
  return `CHANNELSTACK_${driver.toUpperCase()}_APP_${appVariableName(name)}_WEBHOOK_URL`;
}

/** What a driver needs to know of its extra apps beside their records: where their events go, their secrets, their ids. */
export interface AppsContext {
  /** Where this app's events go: the built-in app's from `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL`, another's from its own variable. */
  webhookUrl(app: string): string | undefined;
  /** One of this app's secrets, in the driver's formats; the built-in app's are the driver's own. */
  secret(app: string, name: string): string;
  /** Ids for this app, drawn from the seed and its name, so they don't depend on the order apps are made in. */
  ids(app: string): NamedIds;
}

/** A record of an app: whatever a driver keeps, with its name. */
interface Named {
  readonly name: string;
}

/** Who asks for an app with `createApp`: a session, and the names of its people, which the app may not take. */
interface Asker {
  readonly session: string;
  readonly people: Iterable<string>;
}

/**
 * One channel's apps, the built-in one first. `make` is what `createApp` does: the first call for
 * a name makes the app, later calls with the same settings return it, and anything else is refused.
 *
 * It also keeps which apps each session used: the built-in one, and each it got from `createApp`.
 * Those are the apps its names mean (`namedIn`, `checkPerson`). They are kept in the registry,
 * owned by the session, so they go when it closes.
 */
export class AppRoster<App extends Named> {
  readonly #apps = new Map<string, { app: App; settings: string }>();
  #builtIn: App | undefined;
  readonly #channel: string;
  /** The names of the apps each session used beside the built-in one, in the order it first did. */
  readonly #used: Collection<string>;

  constructor(channel: string, registry: Registry) {
    this.#channel = channel;
    this.#used = registry.collection<string>(channel, "app in use");
  }

  /** The built-in app, set when the fake is seeded (again after a reset). */
  seed(app: App): void {
    this.#builtIn = app;
  }

  get builtIn(): App {
    if (!this.#builtIn) throw new Error(`The ${this.#channel} fake hasn't been seeded`);
    return this.#builtIn;
  }

  /**
   * Make the app named `name` with `settings`, or return the one already made with the same
   * settings. Asked for by a session, the app is one of that session's from then on, and it can't
   * have the name of one of its people.
   */
  make(name: string, settings: Readonly<Record<string, unknown>>, build: () => App, by?: Asker): App {
    if (by) checkNameFree(name, by.people, "app");
    const app = this.#make(name, settings, build);
    if (by) this.#used.add(`${by.session}\u0000${app.name}`, app.name, by.session);
    return app;
  }

  #make(name: string, settings: Readonly<Record<string, unknown>>, build: () => App): App {
    checkAppName(name);
    const key = settingsKey(settings);
    const known = this.#apps.get(name);
    if (known) {
      if (known.settings !== key) {
        throw new ProtocolError(
          "invalid_argument",
          `The ${this.#channel} app "${name}" exists with other settings; an app keeps the settings it was made with`,
          { app: name },
        );
      }
      return known.app;
    }
    if (this.#apps.size >= APP_LIMIT) {
      throw new ProtocolError("invalid_argument", `A channel holds at most ${APP_LIMIT} apps beside ${BUILT_IN_APP}`, {
        limit: APP_LIMIT,
      });
    }
    const app = build();
    this.#apps.set(name, { app, settings: key });
    return app;
  }

  /** The app with this name, the built-in one included. */
  named(name: string): App | undefined {
    return name === BUILT_IN_APP ? this.#builtIn : this.#apps.get(name)?.app;
  }

  /** The apps a session used: the built-in one first, then each it got from `createApp`, in the order it first did. */
  of(session: string): App[] {
    const used = this.#used.list(session).flatMap((name) => {
      const app = this.#apps.get(name)?.app;
      return app ? [app] : [];
    });
    return [this.builtIn, ...used];
  }

  /** The app a name means in a session, in any case: one of the apps that session used. */
  namedIn(session: string, name: string): App | undefined {
    const wanted = name.toLowerCase();
    return this.of(session).find((app) => app.name.toLowerCase() === wanted);
  }

  /** A person of this session may take none of these names: each is the name of an app the session used. */
  checkPerson(session: string, ...names: string[]): void {
    const apps = this.of(session).map((app) => app.name);
    for (const name of names) checkNameFree(name, apps, "person");
  }

  /** The built-in app first, then the others in the order they were made. */
  all(): App[] {
    return [this.builtIn, ...[...this.#apps.values()].map(({ app }) => app)];
  }

  /** The apps tests made, without the built-in one. */
  extra(): App[] {
    return [...this.#apps.values()].map(({ app }) => app);
  }

  /** Change an extra app's record in place (Slack's uninstall, for example). */
  replace(app: App): void {
    if (app.name === BUILT_IN_APP) {
      this.#builtIn = app;
      return;
    }
    const known = this.#apps.get(app.name);
    if (known) known.app = app;
  }
}

/** A name an app may have, and not the built-in app's. */
export function checkAppName(name: string): void {
  if (name === BUILT_IN_APP) {
    throw new ProtocolError("invalid_argument", `"${BUILT_IN_APP}" is the built-in app: use the fixture's app`, {
      app: name,
    });
  }
  if (!APP_NAME.test(name)) {
    throw new ProtocolError(
      "invalid_argument",
      `"${name}" isn't an app name: 1 to 32 lower-case letters, digits and hyphens, starting with a letter`,
      { app: name },
    );
  }
}

/** Settings compared by value, whatever order their keys came in; unset ones don't count. */
function settingsKey(settings: Readonly<Record<string, unknown>>): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, inner]) => inner !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, inner]) => [key, sorted(inner)]),
      );
    }
    return value;
  };
  return JSON.stringify(sorted(settings));
}

/** A person may not take the name of an app their session uses, nor an app a person's: a name in a matcher means one author. */
export function checkNameFree(name: string, taken: Iterable<string>, what: "person" | "app"): void {
  const wanted = name.toLowerCase();
  for (const other of taken) {
    if (other.toLowerCase() === wanted) {
      throw new ProtocolError(
        "invalid_argument",
        what === "person"
          ? `"${name}" is the name of an app in this session: give the person another name`
          : `"${name}" is the name of a person in this session: give the app another name`,
        { name },
      );
    }
  }
}
