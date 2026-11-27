import { ProtocolError } from "../../core/errors/index.ts";

/** One of a slash command's options, as the app registered it. */
export interface CommandOption {
  readonly name: string;
  readonly type: number;
  readonly description?: string;
  readonly required?: boolean;
}

/**
 * What a person typed after a command's name, as its options: `name:value` words for an option by
 * name, the rest in the order the command lists its options, the last of them taking the rest of
 * the text, as a person types a sentence into it. In the command's order, the fake and the browser
 * actor alike; a required option left out is refused, as Discord's client refuses to send it.
 */
export function commandValues(
  command: { readonly name: string; readonly options: readonly CommandOption[] },
  words: readonly string[],
): Array<{ option: CommandOption; text: string }> {
  const filled = new Map<string, string>();
  const positional: string[] = [];
  for (const word of words) {
    const named = /^([\w-]+):(.*)$/.exec(word);
    if (named && command.options.some((option) => option.name === named[1]))
      filled.set(named[1] as string, named[2] ?? "");
    else positional.push(word);
  }
  const free = command.options.filter((option) => !filled.has(option.name));
  free.forEach((option, at) => {
    if (at >= positional.length) return;
    filled.set(option.name, at === free.length - 1 ? positional.slice(at).join(" ") : (positional[at] as string));
  });
  const missing = command.options.find((option) => option.required && !filled.has(option.name));
  if (missing) {
    throw new ProtocolError("invalid_argument", `/${command.name} needs its option "${missing.name}"`, {
      option: missing.name,
    });
  }
  return command.options.flatMap((option) => {
    const text = filled.get(option.name);
    return text === undefined ? [] : [{ option, text }];
  });
}

/**
 * A slash command as a person types it (`/deploy web staging`): the app's command of that name,
 * looked up with `find` (the fake's store, or the app's commands live), and the words after it.
 * One the app hasn't registered is refused as Discord's client has nothing to offer for it.
 */
export async function typedCommand<Command extends { readonly name: string }>(
  text: string,
  find: (name: string) => Command | undefined | Promise<Command | undefined>,
): Promise<{ command: Command; words: string[] }> {
  const [head = "", ...words] = text.trim().split(/\s+/);
  const name = head.replace(/^\//, "");
  const command = await find(name);
  if (!command) {
    throw new ProtocolError("not_found", `The app has no command /${name}: it registers its commands when it starts`, {
      command: name,
    });
  }
  return { command, words };
}
