import type { DevAdapter } from "../core/dev/index.ts";
import type { DriverDefinition } from "../core/router/index.ts";
import type { SecretSpec } from "../core/secrets/index.ts";
import { openai } from "../providers/openai/index.ts";
import { echo } from "./echo/index.ts";
import { github } from "./github/index.ts";
import { google } from "./google/index.ts";
import { linear } from "./linear/index.ts";
import { notion } from "./notion/index.ts";
import { resend } from "./resend/index.ts";
import { slack } from "./slack/index.ts";

/** Every driver in the binary. Core never imports a driver; drivers are handed to it from here. */
export const DRIVERS: readonly DriverDefinition[] = [echo, slack, github, linear, notion, resend, google, openai];

/** The channels people test against: every driver but channelstack's own (`echo`) and the providers, in this order everywhere. */
export const CHANNELS: readonly DriverDefinition[] = DRIVERS.filter((driver) => !driver.internal && !driver.provider);

/** The fakes the agent calls that aren't channels: the fake OpenAI (decision 0029). */
export const PROVIDERS: readonly DriverDefinition[] = DRIVERS.filter((driver) => driver.provider);

/** Each channel's name, for a CLI argument or a script's loop. */
export const CHANNEL_NAMES: readonly string[] = CHANNELS.map((channel) => channel.name);

/** Each channel with its dev adapter, for the dev tools and the UI (`pnpm check:channels` makes sure every one has it). */
export const DEV_CHANNELS: ReadonlyArray<{ name: string; title: string; adapter: DevAdapter }> = CHANNELS.flatMap(
  ({ name, title, dev }) => (dev ? [{ name, title, adapter: dev }] : []),
);

/** What the spec says about each driver (`x-channelstack-channels`), for the code generators and the scripts. */
export function channelsExtension(): Array<{ name: string; title: string; internal?: true; provider?: true }> {
  return DRIVERS.map(({ name, title, internal, provider }) => ({
    name,
    title,
    ...(internal ? { internal: true as const } : {}),
    ...(provider ? { provider: true as const } : {}),
  }));
}

/** The shapes of every platform's tokens, fake or real, for the redactor. */
export const TOKEN_PATTERNS: readonly RegExp[] = DRIVERS.flatMap((driver) => driver.tokenPatterns);

/** Every provider host proxy mode routes to a fake, and that channelstack's CA may vouch for. */
export function proxyHosts(): string[] {
  return DRIVERS.flatMap((driver) => driver.hosts ?? []);
}

/** The secrets every driver declared, for loading and rotating `secrets.json`. */
export function secretSpecs(): Record<string, SecretSpec> {
  return Object.fromEntries(DRIVERS.map((driver) => [driver.name, driver.secrets]));
}
