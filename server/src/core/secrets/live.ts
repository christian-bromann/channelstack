const REDACTED = "[redacted]";

/**
 * A real platform credential: a bot token, a person's token. It lives only in memory and never
 * turns into text by accident: JSON, string conversion and `console.log` all show `[redacted]`.
 * Only the live client that sends it calls `reveal()`.
 */
export class LiveCredential {
  readonly #value: string;
  /** Whose it is, for messages and the ledger: `app`, or `user:<NAME>`. Never the value. */
  readonly owner: string;

  constructor(owner: string, value: string) {
    this.owner = owner;
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  /** The first characters, which name the kind of token (`xoxp-`) and nothing more: for `channelstack doctor`. */
  prefix(): string {
    return this.#value.slice(0, Math.min(5, Math.floor(this.#value.length / 4)));
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** The person's part of `CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN`: `Ana` → `ANA`, `ana-smith` → `ANA_SMITH`. */
function credentialName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * The live credentials a server holds: the apps' from its environment, the people's as tests hand
 * them over. Each value is registered with the redactor, so a copy that slips into a log or an
 * error is scrubbed too.
 */
export class LiveVault {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #register: (secret: string) => void;

  constructor(env: Readonly<Record<string, string | undefined>>, register: (secret: string) => void) {
    this.#env = env;
    this.#register = register;
  }

  /** A credential from the server's environment, or nothing when it isn't set. */
  fromEnv(variable: string, owner = "app"): LiveCredential | undefined {
    const value = this.#env[variable];
    if (!value) return undefined;
    this.#register(value);
    return new LiveCredential(owner, value);
  }

  /** A person's credential a test handed over. */
  person(name: string, value: string): LiveCredential {
    this.#register(value);
    return new LiveCredential(`user:${credentialName(name)}`, value);
  }
}
