import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { randomString } from "./csprng.ts";
import { SECRET_FORMATS, type SecretFormatName, Secrets, type SecretSpec } from "./index.ts";

const posix = process.platform !== "win32";
const everyFormat = Object.fromEntries(Object.keys(SECRET_FORMATS).map((name) => [name, name])) as Record<
  string,
  SecretFormatName
>;
const specs: Record<string, SecretSpec> = { all: everyFormat, echo: { appToken: "echo.appToken" } };
const home = () => mkdtempSync(join(tmpdir(), "cs-secrets-"));

describe("secret formats", () => {
  test.each(Object.entries(SECRET_FORMATS))("%s matches the platform's layout", (name, format) => {
    // An RSA key takes a moment to make, and its layout doesn't vary: a few are enough.
    const draws = name === "github.privateKey" ? 3 : 200;
    for (let i = 0; i < draws; i++) expect(format.generate()).toMatch(format.pattern);
  });

  test("values come from the CSPRNG and don't repeat", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => SECRET_FORMATS["slack.signingSecret"].generate()));
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
    expect(first.get("echo", "appToken")).toMatch(SECRET_FORMATS["echo.appToken"].pattern);
  });

  test("a driver added later gets its secrets without touching the others", () => {
    const dir = home();
    const before = Secrets.load(dir, { echo: { appToken: "echo.appToken" } });
    const after = Secrets.load(dir, { echo: { appToken: "echo.appToken" }, slack: { botToken: "slack.botToken" } });
    expect(after.get("echo", "appToken")).toBe(before.get("echo", "appToken"));
    expect(after.get("slack", "botToken")).toMatch(/^xoxb-/);
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
    const spec = { echo: { appToken: "echo.appToken" } } as const;
    Secrets.load(dir, spec);
    const path = Secrets.path(dir);
    writeFileSync(path, JSON.stringify({ version: 1, secrets: { echo: { appToken: "tampered" } } }));

    const repaired = Secrets.load(dir, spec);

    expect(repaired.get("echo", "appToken")).toMatch(SECRET_FORMATS["echo.appToken"].pattern);
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
