import { randomString } from "./csprng.ts";

export { randomRsaPrivateKey } from "./csprng.ts";

const DIGITS = "0123456789";
const HEX = "0123456789abcdef";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${DIGITS}${UPPER}${UPPER.toLowerCase()}`;
export const UPPER_ALNUM = `${DIGITS}${UPPER}`;

/**
 * A fake token or signing secret, in the platform's own layout (architecture.md 3.2). Each driver
 * declares its own; nothing else generates a secret.
 */
export interface SecretFormat {
  /** What the real platform's value looks like. */
  readonly pattern: RegExp;
  generate(): string;
}

export const digits = (n: number) => randomString(n, DIGITS);
export const hex = (n: number) => randomString(n, HEX);
export const alnum = (n: number) => randomString(n, ALNUM);
