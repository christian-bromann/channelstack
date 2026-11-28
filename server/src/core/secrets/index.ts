import { join } from "node:path";

import { BUILT_IN_APP } from "../apps/index.ts";
import { readPrivateJsonFile, writePrivateFile } from "../home/index.ts";
import type { SecretFormat } from "./formats.ts";

export { randomSeed, randomString, randomToken } from "./csprng.ts";
export { alnum, digits, hex, randomRsaPrivateKey, type SecretFormat, UPPER_ALNUM } from "./formats.ts";
export { LiveCredential, LiveVault } from "./live.ts";

/** The secrets one driver needs: a name of its choosing → the format to generate (in the driver's `secrets.ts`). */
export type SecretSpec = Readonly<Record<string, SecretFormat>>;

type SecretValues = Record<string, Record<string, string>>;
/** The extra apps' secrets: driver → app name → secret name → value. */
type AppSecretValues = Record<string, Record<string, Record<string, string>>>;

interface SecretsFile {
  version: 1;
  secrets: SecretValues;
  /** The apps tests made beside the built-in one (decision 0027), by driver and name. */
  apps?: AppSecretValues;
}

function generateSpec(
  spec: SecretSpec,
  current: Readonly<Record<string, string>>,
): { values: Record<string, string>; changed: boolean } {
  const values: Record<string, string> = {};
  let changed = false;
  for (const [name, format] of Object.entries(spec)) {
    const kept = current[name];
    if (kept !== undefined && format.pattern.test(kept)) {
      values[name] = kept;
    } else {
      values[name] = format.generate();
      changed = true;
    }
  }
  return { values, changed };
}

function generate(
  specs: Readonly<Record<string, SecretSpec>>,
  existing: SecretValues,
): { values: SecretValues; changed: boolean } {
  const values: SecretValues = {};
  let changed = false;
  for (const [driver, spec] of Object.entries(specs)) {
    const next = generateSpec(spec, existing[driver] ?? {});
    values[driver] = next.values;
    changed ||= next.changed;
  }
  return { values, changed };
}

/** Every app's secrets kept, checked against its driver's formats; a driver no longer known drops its apps. */
function generateApps(
  specs: Readonly<Record<string, SecretSpec>>,
  existing: AppSecretValues,
): { values: AppSecretValues; changed: boolean } {
  const values: AppSecretValues = {};
  let changed = false;
  for (const [driver, apps] of Object.entries(existing)) {
    const spec = specs[driver];
    if (spec === undefined) {
      changed = true;
      continue;
    }
    values[driver] = {};
    for (const [app, current] of Object.entries(apps)) {
      const next = generateSpec(spec, current);
      values[driver][app] = next.values;
      changed ||= next.changed;
    }
  }
  return { values, changed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parse(raw: unknown): { secrets: SecretValues; apps: AppSecretValues } {
  if (!isRecord(raw)) return { secrets: {}, apps: {} };
  const { secrets, apps } = raw as Partial<SecretsFile>;
  return { secrets: isRecord(secrets) ? secrets : {}, apps: isRecord(apps) ? apps : {} };
}

/**
 * Fake tokens and signing secrets. Generated once per install from the CSPRNG and kept in
 * `<home>/secrets.json` (0600), so an agent's `.env` stays valid across restarts. Each extra app
 * (decision 0027) has a set of its own, made the first time it is asked for and kept the same way.
 */
export class Secrets {
  readonly #values: SecretValues;
  readonly #apps: AppSecretValues;
  readonly #specs: Readonly<Record<string, SecretSpec>>;
  /** Where new apps' secrets are saved; none for secrets that never touch the disk. */
  readonly #path: string | undefined;
  readonly #listeners: ((values: string[]) => void)[] = [];

  private constructor(
    values: SecretValues,
    apps: AppSecretValues,
    specs: Readonly<Record<string, SecretSpec>>,
    path: string | undefined,
  ) {
    this.#values = values;
    this.#apps = apps;
    this.#specs = specs;
    this.#path = path;
  }

  /** Load the install's secrets, generating and saving whatever is missing. */
  static load(home: string, specs: Readonly<Record<string, SecretSpec>>): Secrets {
    const path = Secrets.path(home);
    const existing = parse(readPrivateJsonFile(path));
    const drivers = generate(specs, existing.secrets);
    const apps = generateApps(specs, existing.apps);
    if (drivers.changed || apps.changed) Secrets.#save(path, drivers.values, apps.values);
    return new Secrets(drivers.values, apps.values, specs, path);
  }

  /** Replace every secret with a new one (`channelstack secrets rotate`), the apps' too. */
  static rotate(home: string, specs: Readonly<Record<string, SecretSpec>>): Secrets {
    const path = Secrets.path(home);
    const { values } = generate(specs, {});
    const known = parse(readPrivateJsonFile(path)).apps;
    const emptied = Object.fromEntries(
      Object.entries(known).map(([driver, apps]) => [
        driver,
        Object.fromEntries(Object.keys(apps).map((app) => [app, {}])),
      ]),
    );
    const apps = generateApps(specs, emptied).values;
    Secrets.#save(path, values, apps);
    return new Secrets(values, apps, specs, path);
  }

  /** Secrets that never touch the disk: for generating the spec, and for unit tests. */
  static ephemeral(specs: Readonly<Record<string, SecretSpec>>): Secrets {
    return new Secrets(generate(specs, {}).values, {}, specs, undefined);
  }

  static path(home: string): string {
    return join(home, "secrets.json");
  }

  static #save(path: string, values: SecretValues, apps: AppSecretValues): void {
    const file: SecretsFile = { version: 1, secrets: values, ...(Object.keys(apps).length > 0 ? { apps } : {}) };
    writePrivateFile(path, `${JSON.stringify(file, null, 2)}\n`);
  }

  get(driver: string, name: string): string {
    const value = this.#values[driver]?.[name];
    if (value === undefined) throw new Error(`No secret "${name}" declared by driver "${driver}"`);
    return value;
  }

  /**
   * One of an app's secrets. The built-in app's are the driver's own; another app's set is made
   * the first time any of it is asked for, saved, and handed to whoever listens (the redactor).
   */
  forApp(driver: string, app: string, name: string): string {
    if (app === BUILT_IN_APP) return this.get(driver, name);
    const spec = this.#specs[driver];
    if (spec === undefined) throw new Error(`No secrets declared by driver "${driver}"`);
    const apps = this.#apps[driver] ?? {};
    this.#apps[driver] = apps;
    let values = apps[app];
    if (values === undefined) {
      values = generateSpec(spec, {}).values;
      apps[app] = values;
      if (this.#path !== undefined) Secrets.#save(this.#path, this.#values, this.#apps);
      for (const listener of this.#listeners) listener(Object.values(values));
    }
    const value = values[name];
    if (value === undefined) throw new Error(`No secret "${name}" declared by driver "${driver}"`);
    return value;
  }

  /** Called with each new app's secrets as they are made, so they are scrubbed like the rest. */
  onNew(listener: (values: string[]) => void): void {
    this.#listeners.push(listener);
  }

  /** Every secret value, the apps' too, for the redactor. */
  all(): string[] {
    return [
      ...Object.values(this.#values).flatMap((driver) => Object.values(driver)),
      ...Object.values(this.#apps).flatMap((apps) => Object.values(apps).flatMap((app) => Object.values(app))),
    ];
  }
}
