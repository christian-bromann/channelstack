import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { randomString } from "./csprng.ts";
import { alnum, hex, type SecretFormat, Secrets, type SecretSpec } from "./index.ts";

const posix = process.platform !== "win32";
/** Formats of a made-up platform: the store works with any driver's. Each driver's own are tested in drivers/formats.test.ts. */
const TOKEN: SecretFormat = { pattern: /^tok_[A-Za-z0-9]{32}$/, generate: () => `tok_${alnum(32)}` };
const SIGNING: SecretFormat = { pattern: /^[a-f0-9]{40}$/, generate: () => hex(40) };
const BOT: SecretFormat = { pattern: /^bot-[a-f0-9]{24}$/, generate: () => `bot-${hex(24)}` };
const everyFormat = { token: TOKEN, signing: SIGNING, bot: BOT };
const specs: Record<string, SecretSpec> = { all: everyFormat, echo: { appToken: TOKEN } };
const home = () => mkdtempSync(join(tmpdir(), "cs-secrets-"));

describe("secret formats", () => {
  test("values come from the CSPRNG and don't repeat", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => SIGNING.generate()));
    expect(seen.size).toBe(2000);
    expect(randomString(64, "ab")).toMatch(/^[ab]{64}$/);
  });
});

describe("secrets.json", () => {
  test.runIf(posix)("exit check 0.6: it is created with mode 0600", () => {
    const dir = home();
    Secrets.load(dir, specs);
    expect(statSync(Secrets.path(dir)).mode & 0o777).toBe(0o600);
  });

  test("secrets are generated once per install and stay stable across loads", () => {
    const dir = home();
    const first = Secrets.load(dir, specs);
    const second = Secrets.load(dir, specs);
    expect(second.all()).toEqual(first.all());
    expect(first.get("echo", "appToken")).toMatch(TOKEN.pattern);
  });

  test("a driver added later gets its secrets without touching the others", () => {
    const dir = home();
    const before = Secrets.load(dir, { echo: { appToken: TOKEN } });
    const after = Secrets.load(dir, { echo: { appToken: TOKEN }, slack: { botToken: BOT } });
    expect(after.get("echo", "appToken")).toBe(before.get("echo", "appToken"));
    expect(after.get("slack", "botToken")).toMatch(/^bot-/);
  });

  test("exit check 0.6: rotate changes every value and keeps the file private", () => {
    const dir = home();
    const before = Secrets.load(dir, specs);
    const rotated = Secrets.rotate(dir, specs);

    const old = new Set(before.all());
    expect(rotated.all().length).toBe(before.all().length);
    for (const value of rotated.all()) expect(old.has(value)).toBe(false);
    expect(Secrets.load(dir, specs).all()).toEqual(rotated.all());
    if (posix) expect(statSync(Secrets.path(dir)).mode & 0o777).toBe(0o600);
  });

  test("a value that doesn't match its format is replaced, not served", () => {
    const dir = home();
    const spec = { echo: { appToken: TOKEN } };
    Secrets.load(dir, spec);
    const path = Secrets.path(dir);
    writeFileSync(path, JSON.stringify({ version: 1, secrets: { echo: { appToken: "tampered" } } }));

    const repaired = Secrets.load(dir, spec);

    expect(repaired.get("echo", "appToken")).toMatch(TOKEN.pattern);
    expect(JSON.parse(readFileSync(path, "utf8")).secrets.echo.appToken).toBe(repaired.get("echo", "appToken"));
  });

  test.runIf(posix)("a secrets.json that others can read is made private again on load, without changing it", () => {
    const dir = home();
    const first = Secrets.load(dir, specs);
    chmodSync(Secrets.path(dir), 0o644);

    const second = Secrets.load(dir, specs);

    expect(statSync(Secrets.path(dir)).mode & 0o777).toBe(0o600);
    expect(second.all()).toEqual(first.all());
  });

  test("a truncated file is an error that names the file and says how to recover", () => {
    const dir = home();
    writeFileSync(Secrets.path(dir), '{"version":1,"secr');
    expect(() => Secrets.load(dir, specs)).toThrow(`${Secrets.path(dir)} is not valid JSON. Delete it and start again`);
  });

  test("a file with the wrong shape starts over, and unknown secrets are an error", () => {
    const dir = home();
    writeFileSync(Secrets.path(dir), "[]");
    const secrets = Secrets.load(dir, specs);
    expect(() => secrets.get("echo", "nope")).toThrow(/No secret/);
    expect(Secrets.ephemeral(specs).all()).toHaveLength(Object.keys(everyFormat).length + 1);
  });
});

describe("an app's secrets (decision 0027)", () => {
  test("exit check 12.5: they are made once, kept in secrets.json (0600) and the same after a restart", () => {
    const dir = home();
    const first = Secrets.load(dir, specs);
    const token = first.forApp("echo", "coder", "appToken");

    expect(token).toMatch(TOKEN.pattern);
    expect(token).not.toBe(first.get("echo", "appToken"));
    expect(first.forApp("echo", "coder", "appToken")).toBe(token);
    expect(Secrets.load(dir, specs).forApp("echo", "coder", "appToken")).toBe(token);
    expect(JSON.parse(readFileSync(Secrets.path(dir), "utf8")).apps.echo.coder.appToken).toBe(token);
    if (posix) expect(statSync(Secrets.path(dir)).mode & 0o777).toBe(0o600);
  });

  test("the built-in app's are the driver's own", () => {
    const secrets = Secrets.load(home(), specs);
    expect(secrets.forApp("echo", "my-agent", "appToken")).toBe(secrets.get("echo", "appToken"));
  });

  test("exit check 12.5: rotate changes them too, and keeps the app", () => {
    const dir = home();
    const token = Secrets.load(dir, specs).forApp("echo", "coder", "appToken");
    const rotated = Secrets.rotate(dir, specs);
    expect(rotated.all()).not.toContain(token);
    expect(JSON.parse(readFileSync(Secrets.path(dir), "utf8")).apps.echo.coder.appToken).toMatch(TOKEN.pattern);
  });

  test("they are handed to listeners as they are made, and are in all()", () => {
    const secrets = Secrets.ephemeral(specs);
    const heard: string[] = [];
    secrets.onNew((values) => heard.push(...values));
    const token = secrets.forApp("echo", "coder", "appToken");
    secrets.forApp("echo", "coder", "appToken");
    expect(heard).toEqual([token]);
    expect(secrets.all()).toContain(token);
  });

  test("a tampered value of an app's is replaced on load", () => {
    const dir = home();
    const spec = { echo: { appToken: TOKEN } };
    const path = Secrets.path(dir);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, secrets: {}, apps: { echo: { coder: { appToken: "tampered" } } } }),
    );
    expect(Secrets.load(dir, spec).forApp("echo", "coder", "appToken")).toMatch(TOKEN.pattern);
  });
});
