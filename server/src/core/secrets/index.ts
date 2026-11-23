import { join } from "node:path";

import { readPrivateJsonFile, writePrivateFile } from "../home/index.ts";
import { SECRET_FORMATS, type SecretFormatName } from "./formats.ts";

export { randomSeed, randomString, randomToken } from "./csprng.ts";
export { SECRET_FORMATS, type SecretFormatName } from "./formats.ts";
export { credentialName, LiveCredential, LiveVault } from "./live.ts";

/** The secrets one driver needs: a name of its choosing → the format to generate. */
export type SecretSpec = Readonly<Record<string, SecretFormatName>>;

type SecretValues = Record<string, Record<string, string>>;

interface SecretsFile {
  version: 1;
  secrets: SecretValues;
}

function generate(
  specs: Readonly<Record<string, SecretSpec>>,
  existing: SecretValues,
): { values: SecretValues; changed: boolean } {
  const values: SecretValues = {};
  let changed = false;
  for (const [driver, spec] of Object.entries(specs)) {
    const current = existing[driver] ?? {};
    const next: Record<string, string> = {};
    for (const [name, format] of Object.entries(spec)) {
      const kept = current[name];
      if (kept !== undefined && SECRET_FORMATS[format].pattern.test(kept)) {
        next[name] = kept;
      } else {
        next[name] = SECRET_FORMATS[format].generate();
        changed = true;
      }
    }
    values[driver] = next;
  }
  return { values, changed };
}

function parse(raw: unknown): SecretValues {
  if (typeof raw !== "object" || raw === null) return {};
  const secrets = (raw as Partial<SecretsFile>).secrets;
  return typeof secrets === "object" && secrets !== null ? secrets : {};
}

/**
 * Fake tokens and signing secrets. Generated once per install from the CSPRNG and kept in
 * `<home>/secrets.json` (0600), so an agent's `.env` stays valid across restarts.
 */
export class Secrets {
  readonly #values: SecretValues;

  private constructor(values: SecretValues) {
    this.#values = values;
  }

  /** Load the install's secrets, generating and saving whatever is missing. */
  static load(home: string, specs: Readonly<Record<string, SecretSpec>>): Secrets {
    const path = Secrets.path(home);
    const { values, changed } = generate(specs, parse(readPrivateJsonFile(path)));
    if (changed) Secrets.#save(path, values);
    return new Secrets(values);
  }

  /** Replace every secret with a new one (`channelstack secrets rotate`). */
  static rotate(home: string, specs: Readonly<Record<string, SecretSpec>>): Secrets {
    const { values } = generate(specs, {});
    Secrets.#save(Secrets.path(home), values);
    return new Secrets(values);
  }

  /** Secrets that never touch the disk: for generating the spec, and for unit tests. */
  static ephemeral(specs: Readonly<Record<string, SecretSpec>>): Secrets {
    return new Secrets(generate(specs, {}).values);
  }

  static path(home: string): string {
    return join(home, "secrets.json");
  }

  static #save(path: string, values: SecretValues): void {
    const file: SecretsFile = { version: 1, secrets: values };
    writePrivateFile(path, `${JSON.stringify(file, null, 2)}\n`);
  }

  get(driver: string, name: string): string {
    const value = this.#values[driver]?.[name];
    if (value === undefined) throw new Error(`No secret "${name}" declared by driver "${driver}"`);
    return value;
  }

  /** Every secret value, for the redactor. */
  all(): string[] {
    return Object.values(this.#values).flatMap((driver) => Object.values(driver));
  }
}
