import { describe, expect, test } from "vitest";

import { DEV_CHANNELS } from "../drivers/index.ts";
import { actionsOf, VERBS } from "./act.ts";
import { type Command, find, flagsOf, parseOptions, renderHelp, ROOT } from "./help.ts";

const help = (...words: string[]) => {
  const found = find(words);
  if (!found.ok) throw new Error(`no command ${words.join(" ")}`);
  return renderHelp(found.path, { version: "1.2.3" });
};

/** Every command in the tree, with the path to it. */
function walk(path: readonly Command[] = [ROOT]): Array<readonly Command[]> {
  const here = path.at(-1) as Command;
  const below = here.commands?.flatMap((group) => group.commands) ?? [];
  return [path, ...below.flatMap((child) => walk([...path, child]))];
}

describe("help", () => {
  test("the top level lists the commands and channels, not each channel's commands", () => {
    const text = help();
    expect(text).toContain("channelstack 1.2.3");
    for (const name of [
      "start",
      "env",
      "mcp",
      "openai",
      "show",
      "doctor",
      "secrets",
      ...DEV_CHANNELS.map((c) => c.name),
    ])
      expect(text).toMatch(new RegExp(`^  ${name} `, "m"));
    expect(text).not.toContain("--as <name>");
    expect(text).not.toContain("--no-portless");
  });

  test("a channel's help lists its commands and every action its routes generate", () => {
    for (const channel of DEV_CHANNELS) {
      const text = help(channel.name);
      for (const action of actionsOf(channel.name)) expect(text).toMatch(new RegExp(`^  ${action.name} `, "m"));
      // A channel whose people don't react has no `react` command.
      expect(/^ {2}react {2,}React to an entry/m.test(text)).toBe(channel.adapter.react !== undefined);
    }
  });

  test("an action's help lists its values, positional ones in the usage", () => {
    const text = help("slack", "click");
    expect(text).toContain("channelstack slack click <button> [flags]");
    expect(text).toMatch(/--button <value> +SlackButtonRef \(or its label\); required, or the 1st/);
    expect(text).toContain("--on <ref>");
  });

  test("an action named like a command is under `act`", () => {
    expect(help("slack", "act", "say")).toContain("channelstack slack act say <message> [flags]");
    expect(help("slack", "say")).toContain("channelstack slack act say --help");
  });

  test("a subcommand's help is its own", () => {
    const text = help("openai", "respond");
    expect(text).toContain("--times <n>");
    expect(text).not.toContain("--no-portless");
  });

  test("prose stays within 80 columns; a command in it is never broken", () => {
    for (const path of walk()) {
      const text = renderHelp(path, { version: "1.2.3" });
      let section = "";
      for (const line of text.split("\n")) {
        if (/^[A-Z][A-Z ]+$/.test(line)) section = line;
        if (section === "USAGE" || section === "EXAMPLES") continue;
        expect(line.length, `${path.map((c) => c.name).join(" ")}: ${line}`).toBeLessThanOrEqual(80);
        expect((line.match(/`/g) ?? []).length % 2, line).toBe(0);
      }
    }
  });

  test("bold headings only when asked", () => {
    const found = find([]);
    if (!found.ok) throw new Error("no root");
    expect(renderHelp(found.path, { version: "1", style: { bold: true } })).toContain("\x1b[1mUSAGE\x1b[22m");
    expect(renderHelp(found.path, { version: "1" })).not.toContain("\x1b[");
  });
});

describe("finding a command", () => {
  test("walks down as far as there are subcommands; the rest are arguments", () => {
    const found = find(["slack", "say", "hello there"]);
    expect(found.ok && found.path.map((command) => command.name)).toEqual(["channelstack", "slack", "say"]);
  });

  test("an unknown command names the one that was probably meant", () => {
    expect(find(["slak"])).toMatchObject({ ok: false, typed: "slak", suggestion: "slack" });
    expect(find(["slack", "clik"])).toMatchObject({ ok: false, typed: "clik", suggestion: "click" });
    expect(find(["frobnicate"])).toMatchObject({ ok: false, typed: "frobnicate" });
    expect(find(["frobnicate"])).not.toHaveProperty("suggestion");
  });

  test("each command takes its own flags, the server's when it attaches, and --help", () => {
    const flags = (...words: string[]) => {
      const found = find(words);
      return found.ok ? [...flagsOf(found.path.at(-1) as Command).keys()] : [];
    };
    expect(flags("env")).toEqual(expect.arrayContaining(["proxy", "app", "channel", "server", "help"]));
    expect(flags("env")).not.toContain("once");
    expect(flags("start")).not.toContain("server");
    expect(flags("slack", "click")).toEqual(expect.arrayContaining(["button", "message", "as", "in", "on", "json"]));
  });

  test("no flag is a switch for one command and takes a value for another", () => {
    const types = new Map<string, Set<boolean>>();
    for (const path of walk())
      for (const flag of flagsOf(path.at(-1) as Command).values())
        types.set(flag.name, (types.get(flag.name) ?? new Set()).add(flag.value !== undefined));
    expect([...types].filter(([, kinds]) => kinds.size > 1).map(([name]) => name)).toEqual([]);
    expect(parseOptions()).toMatchObject({ help: { type: "boolean", short: "h" }, as: { type: "string" } });
  });

  test("every channel has the same commands", () => {
    for (const channel of DEV_CHANNELS) {
      const found = find([channel.name]);
      const names = found.ok ? (found.path.at(-1)?.commands?.[0]?.commands.map((command) => command.name) ?? []) : [];
      const expected = VERBS.filter(
        (verb) =>
          (verb !== "react" || channel.adapter.react) &&
          (verb !== "act" ||
            actionsOf(channel.name).some((action) => (VERBS as readonly string[]).includes(action.name))),
      );
      expect(names, channel.name).toEqual(expected);
    }
  });
});
