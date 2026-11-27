import { randomInt } from "node:crypto";

import { hex, randomString, type SecretFormat } from "../../core/secrets/index.ts";

/** What a bot token's parts are made of: base-64-url's characters. */
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A bot token's first part: its bot's user id, in base 64 without the padding, as Discord makes them. */
const idPart = (id: string) => Buffer.from(id).toString("base64").replace(/=+$/, "");

/** A bot token for a bot with an id of `digits` digits: `<id in base 64>.<6>.<38>`. */
const botToken = (digits: number) => () =>
  `${idPart(`${randomInt(1, 10)}${randomString(digits - 1, "0123456789")}`)}.${randomString(6, URL_SAFE)}.${randomString(38, URL_SAFE)}`;

/** A bot token's shape: the id part starts `M`, `N` or `O`, since an id's first digit is 1 to 9. */
const BOT_TOKEN = /^[MNO][A-Za-z0-9_-]{22,26}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{38}$/;

/** Every credential of the Discord platform the driver knows, in its own layout. */
export const DISCORD_SECRETS = {
  // The agent's bot token. Its bot's id (an older app's: 18 digits) is in its first part.
  botToken: { pattern: BOT_TOKEN, generate: botToken(18) },
  // The Ed25519 key interactions are signed with: its 32-byte seed, as hex. The app's public key is its other half.
  interactionsKey: { pattern: /^[0-9a-f]{64}$/, generate: () => hex(64) },
  // An interaction's token: "interaction:" in base 64, then the rest. Made per interaction, good for 15 minutes.
  interactionToken: {
    pattern: /^aW50ZXJhY3Rpb246[A-Za-z0-9_-]{150}$/,
    generate: () => `aW50ZXJhY3Rpb246${randomString(150, URL_SAFE)}`,
  },
  // A bot token of an app made since 2022, whose id has 19 digits: what live bots have. The fake never makes one.
  liveBotToken: { pattern: BOT_TOKEN, generate: botToken(19) },
} as const satisfies Record<string, SecretFormat>;

/** The bot's user id, from its token's first part, or nothing for something that isn't a bot token. */
export function botIdOf(token: string): string | undefined {
  const [first] = token.split(".");
  if (!first || !BOT_TOKEN.test(token)) return undefined;
  const id = Buffer.from(first, "base64").toString("utf8");
  return /^[1-9]\d{16,19}$/.test(id) ? id : undefined;
}
