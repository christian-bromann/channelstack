import type { DriverDefinition } from "../core/router/index.ts";
import type { SecretSpec } from "../core/secrets/index.ts";
import { echo } from "./echo/index.ts";
import { github } from "./github/index.ts";
import { linear } from "./linear/index.ts";
import { notion } from "./notion/index.ts";
import { slack } from "./slack/index.ts";

/** Every driver in the binary. Core never imports a driver; drivers are handed to it from here. */
export const DRIVERS: readonly DriverDefinition[] = [echo, slack, github, linear, notion];

/** The secrets every driver declared, for loading and rotating `secrets.json`. */
export function secretSpecs(): Record<string, SecretSpec> {
  return Object.fromEntries(DRIVERS.map((driver) => [driver.name, driver.secrets]));
}
