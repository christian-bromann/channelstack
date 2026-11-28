import { describe, expect, test } from "vitest";

import { ProtocolError } from "../errors/index.ts";
import { Registry } from "../registry/index.ts";
import { APP_LIMIT, AppRoster, appVariableName, appWebhookVariable, checkNameFree } from "./index.ts";

const roster = () => {
  const apps = new AppRoster<{ name: string; made: number }>("slack", new Registry());
  apps.seed({ name: "my-agent", made: 0 });
  return apps;
};
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof ProtocolError ? error.code : String(error);
  }
  return "no refusal";
};

describe("exit check 12.12: names and limits", () => {
  test("the same name and settings return the same app, made once", () => {
    const apps = roster();
    let made = 0;
    const build = () => ({ name: "coder", made: ++made });
    const first = apps.make("coder", { scopes: ["a", "b"] }, build);
    expect(apps.make("coder", { scopes: ["a", "b"], unset: undefined }, build)).toBe(first);
    expect(made).toBe(1);
    expect(apps.all().map(({ name }) => name)).toEqual(["my-agent", "coder"]);
    expect(apps.named("coder")).toBe(first);
    expect(apps.named("my-agent")?.made).toBe(0);
  });

  test("a taken name with other settings is refused", () => {
    const apps = roster();
    apps.make("coder", { scopes: ["a"] }, () => ({ name: "coder", made: 1 }));
    expect(refusal(() => apps.make("coder", { scopes: ["b"] }, () => ({ name: "coder", made: 2 })))).toBe(
      "invalid_argument",
    );
  });

  test("my-agent and names outside the format are refused", () => {
    const apps = roster();
    for (const name of ["my-agent", "Coder", "code_reviewer", "9lives", "", "a".repeat(33), "-x"]) {
      expect(refusal(() => apps.make(name, {}, () => ({ name, made: 1 })))).toBe("invalid_argument");
    }
    expect(refusal(() => apps.make("a".repeat(32), {}, () => ({ name: "a".repeat(32), made: 1 })))).toBe("no refusal");
  });

  test(`an app beyond ${APP_LIMIT} beside my-agent is refused`, () => {
    const apps = roster();
    for (let i = 0; i < APP_LIMIT; i++) apps.make(`app-${i}`, {}, () => ({ name: `app-${i}`, made: i }));
    expect(refusal(() => apps.make("one-more", {}, () => ({ name: "one-more", made: 99 })))).toBe("invalid_argument");
    // Asking again for one that exists still works at the limit.
    expect(refusal(() => apps.make("app-0", {}, () => ({ name: "app-0", made: 0 })))).toBe("no refusal");
  });

  test("a person and an app of one session can't share a name", () => {
    expect(refusal(() => checkNameFree("Coder", ["coder"], "person"))).toBe("invalid_argument");
    expect(refusal(() => checkNameFree("coder", ["Ana"], "app"))).toBe("no refusal");
  });

  test("a name means the apps its session used, and a closed session's are forgotten", () => {
    const registry = new Registry();
    const apps = new AppRoster<{ name: string; made: number }>("slack", registry);
    apps.seed({ name: "my-agent", made: 0 });
    const build = () => ({ name: "reviewer", made: 1 });
    const reviewer = apps.make("reviewer", {}, build, { session: "s1", people: ["Ana"] });

    expect(apps.of("s1")).toEqual([apps.builtIn, reviewer]);
    expect(apps.namedIn("s1", "Reviewer")).toBe(reviewer);
    expect(refusal(() => apps.checkPerson("s1", "Reviewer"))).toBe("invalid_argument");
    // Another session never used it: the name is free for its people, and means nobody there.
    expect(apps.of("s2")).toEqual([apps.builtIn]);
    expect(apps.namedIn("s2", "reviewer")).toBeUndefined();
    expect(apps.namedIn("s2", "my-agent")).toBe(apps.builtIn);
    expect(refusal(() => apps.checkPerson("s2", "Reviewer"))).toBe("no refusal");
    // Once a session has a person of that name, it can't ask for the app.
    expect(refusal(() => apps.make("reviewer", {}, build, { session: "s2", people: ["Reviewer"] }))).toBe(
      "invalid_argument",
    );
    expect(apps.of("s2")).toEqual([apps.builtIn]);

    registry.release("s1");
    expect(apps.of("s1")).toEqual([apps.builtIn]);
    expect(refusal(() => apps.checkPerson("s1", "Reviewer"))).toBe("no refusal");
    // The app itself stays: it belongs to the world.
    expect(apps.named("reviewer")).toBe(reviewer);
  });

  test("each name has one variable name", () => {
    expect(appVariableName("code-reviewer")).toBe("CODE_REVIEWER");
    expect(appWebhookVariable("slack", "coder")).toBe("CHANNELSTACK_SLACK_APP_CODER_WEBHOOK_URL");
  });

  test("R1.2: one owner for acting as an app, finding it by a handle, its env and its credentials", () => {
    const registry = new Registry();
    type App = { name: string; id: string; bot: string };
    const apps = new AppRoster<App>("Slack", registry, { refs: (app) => [app.id, app.bot] });
    const builtIn = { name: "my-agent", id: "A0", bot: "U0" };
    apps.seed(builtIn);
    const coder = apps.make("coder", {}, () => ({ name: "coder", id: "A1", bot: "U1" }), { session: "s1", people: [] });

    // A handle's id names its app anywhere; a name only among the apps its session used.
    expect(apps.byId("U1")).toBe(coder);
    expect(apps.find("coder")).toBe(coder);
    expect(apps.get("s1", "A1")).toBe(coder);
    expect(apps.get("s1", "coder")).toBe(coder);
    expect(apps.get("s2", "my-agent")).toBe(builtIn);
    expect(refusal(() => apps.get("s2", "coder"))).toBe("not_found");
    expect(refusal(() => apps.get("s2", "A1"))).toBe("not_found");

    // A test acts as an app its session made, never as my-agent.
    expect(apps.scripted("s1", "coder")).toBe(coder);
    expect(refusal(() => apps.scripted("s1", "A0"))).toBe("invalid_argument");
    expect(refusal(() => apps.scripted("s2", "coder"))).toBe("not_found");

    // `env --app` makes an app nobody asked for yet, and keys the built-in one as my-agent.
    let made = 0;
    const later = (name: string) => apps.make(name, {}, () => ({ name, id: `A${++made + 1}`, bot: "U9" }));
    expect(apps.forEnv(undefined, later)).toBe(builtIn);
    expect(apps.forEnv("coder", later)).toBe(coder);
    expect(apps.forEnv("writer", later).name).toBe("writer");
    expect(made).toBe(1);
    expect(apps.keyOf(builtIn)).toBe("my-agent");

    // A credential answers as the app whose it is, by the name core keeps its secrets under.
    const secret = (app: string) => `token-of-${app}`;
    expect(apps.withSecret("token-of-coder", secret)).toBe(coder);
    expect(apps.withSecret("token-of-my-agent", secret)).toBe(builtIn);
    expect(apps.withSecret("token-of-nobody", secret)).toBeUndefined();
    expect(apps.withSecret("", secret)).toBeUndefined();
    expect(apps.withSecret(undefined, secret)).toBeUndefined();
  });
});
