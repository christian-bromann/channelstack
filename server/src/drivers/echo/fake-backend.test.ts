import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { systemClock, systemTimers } from "../../core/clock/index.ts";
import { DeliveryQueue } from "../../core/delivery/index.ts";
import { EventLog } from "../../core/events/index.ts";
import { IdGenerator } from "../../core/ids/index.ts";
import { createLogger } from "../../core/log/index.ts";
import { Redactor } from "../../core/redact/index.ts";
import { Registry } from "../../core/registry/index.ts";
import type { DriverContext, FakeBackend } from "../../core/router/index.ts";
import { createEchoFake } from "./fake/index.ts";

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

/** The member names of `interface FakeBackend { … }` in a piece of TypeScript. */
function fakeBackendMembers(source: string): string[] {
  const body = /interface FakeBackend \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (body === undefined) throw new Error("no `interface FakeBackend` found");
  return [...body.matchAll(/^\s*(?:readonly )?(\w+)[(:]/gm)].map((match) => match[1] as string);
}

function context(): DriverContext {
  const redactor = new Redactor();
  const log = createLogger({ level: "silent", redactor, write: () => {} });
  const events = new EventLog(systemClock, redactor);
  return {
    ids: new IdGenerator({ seed: 1, clock: systemClock }),
    clock: systemClock,
    timers: systemTimers,
    registry: new Registry(),
    events,
    delivery: new DeliveryQueue({ events, clock: systemClock, timers: systemTimers, log }),
    log,
    expectMore: () => {},
    arrived: () => {},
    secret: (name) => `secret-for-${name}`,
    apiUrl: () => "http://127.0.0.1:4500/echo",
    webhookUrl: undefined,
  };
}

describe("exit check 0.7: the fake store design is locked", () => {
  test("docs/decisions/0001-fake-backend.md describes the interface the code has", () => {
    const decision = read("docs/decisions/0001-fake-backend.md");
    const code = read("server/src/core/router/driver.ts");

    expect(fakeBackendMembers(decision)).toEqual(["api", "seed", "release"]);
    expect(fakeBackendMembers(code)).toEqual(fakeBackendMembers(decision));
    for (const part of ["context.ids", "context.registry", "context.events", "context.delivery", "context.secret"]) {
      expect(decision).toContain(part);
    }
  });

  test("the echo fake implements FakeBackend", async () => {
    // `satisfies` makes this a compile-time check too: `pnpm typecheck` fails if the echo fake drifts.
    const fake = createEchoFake(context()) satisfies FakeBackend;

    const unauthenticated = await fake.api.fetch(new Request("http://echo.localhost/api/messages", { method: "POST" }));
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ ok: false, error: "invalid_auth" });
  });

  test("seeding creates the app, a reset re-seeds it, and a closed session's rooms are released", () => {
    const ctx = context();
    const fake = createEchoFake(ctx);
    const app = fake.world.app();
    expect(app).toMatchObject({ name: "echo-agent", kind: "app" });
    expect(app.id).toMatch(/^EA[0-9A-Z]{10}$/);

    const ana = fake.world.createUser("ses_a", { name: "Ana" });
    const room = fake.world.createRoom("ses_a", { participants: [ana.id, app.id] });
    fake.world.postAsUser("ses_a", ana.id, room.id, "hello");
    expect(fake.world.messages("ses_a", room.id).messages).toHaveLength(1);

    fake.release("ses_a");
    ctx.registry.release("ses_a");
    expect(() => fake.world.messages("ses_a", room.id)).toThrow(/No echo room/);

    ctx.registry.clear();
    fake.seed();
    expect(fake.world.app().id).not.toBe(app.id);
  });
});
