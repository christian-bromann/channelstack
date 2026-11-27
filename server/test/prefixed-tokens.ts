import type { SecretFormat } from "../src/core/secrets/index.ts";
import { DRIVERS } from "../src/drivers/index.ts";

/**
 * The literal text a format's pattern starts with (`xoxb-`, `GOCSPX-`, `1//0`, `ya29.`, `AC`), escapes
 * read as the character they stand for; empty where it starts with a class (`[0-9a-f]`, `\d`).
 */
function literalPrefix(pattern: RegExp): string {
  const source = pattern.source;
  if (!source.startsWith("^")) return "";
  let prefix = "";
  let at = 1;
  while (at < source.length) {
    const char = source[at] as string;
    if (char === "\\") {
      const next = source[at + 1];
      // `\d`, `\w`, `\n`: a class or a control character, not literal text.
      if (next === undefined || /[A-Za-z0-9]/.test(next)) break;
      prefix += next;
      at += 2;
    } else if (/[[\](){}.*+?|$^]/.test(char)) break;
    else {
      prefix += char;
      at += 1;
    }
  }
  // A quantifier after the last character makes it optional or repeated: not part of the prefix.
  return /^[*+?{]/.test(source.slice(at)) ? prefix.slice(0, -1) : prefix;
}

/**
 * Every secret format a driver declares, and the tokens it issues beyond them, that has a
 * recognisable prefix (`xoxb-`, `ntn_`, `GOCSPX-`, `ya29.`, Twilio's two-letter `AC`): the redactor
 * scrubs those by their shape, and the rest by value once loaded. A private key's armour isn't a
 * token's prefix.
 */
export const PREFIXED_TOKENS: ReadonlyArray<readonly [name: string, format: SecretFormat]> = DRIVERS.flatMap(
  (driver) => [
    ...Object.entries(driver.secrets).map(([name, format]) => [`${driver.name}.${name}`, format] as const),
    ...(driver.liveTokens ?? []).map((format, at) => [`${driver.name} token ${at + 1}`, format] as const),
  ],
).filter(([, format]) => literalPrefix(format.pattern).length >= 2 && !format.pattern.source.includes("PRIVATE KEY"));
