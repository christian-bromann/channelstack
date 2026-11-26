import { idFormats, type IdShape, UPPER_ALNUM } from "../../core/ids/index.ts";

/** An echo id: the echo platform is channelstack's own, so this format is ours. */
function echo(prefix: string): IdShape {
  return {
    pattern: new RegExp(`^${prefix}[0-9A-Z]{10}$`),
    generate: (draw) => `${prefix}${draw.chars(10, UPPER_ALNUM)}`,
  };
}

/**
 * Every id the Echo fake generates, in the platform's own format (architecture.md 3.2).
 */
export const ECHO_IDS = idFormats("echo", {
  app: echo("EA"),
  user: echo("EU"),
  room: echo("ER"),
  message: echo("EM"),
  delivery: echo("ED"),
});
