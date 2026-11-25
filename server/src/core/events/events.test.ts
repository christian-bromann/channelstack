import { describe, expect, test } from "vitest";

import { Redactor } from "../redact/index.ts";
import { CursorList, EventLog, WORLD_SCOPE } from "./index.ts";

describe("the event log", () => {
  test("delivery attempts and API calls get a one-line summary; a failure says how it failed", () => {
    const log = new EventLog(() => 0, new Redactor());
    const say = (kind: Parameters<EventLog["append"]>[2], data: Record<string, unknown>) =>
      log.append("ses_a", "slack", kind, data);

    say("action", { type: "say" });
    say("delivery", { id: "dlv_1", type: "event_callback", eventType: "app_mention" });
    say("delivery_attempt", { id: "dlv_1", number: 1, status: "timed_out" });
    say("delivery_attempt", { id: "dlv_1", number: 2, status: "acknowledged", responseStatus: 200 });
    say("api_call", { operation: "chat.postMessage", responseStatus: 200 });
    say("api_call", { operation: "chat.postMessage", responseStatus: 429, error: "ratelimited" });
    // A delivery of another session with the same id doesn't lend its type.
    log.append("ses_b", "slack", "delivery_attempt", { id: "dlv_1", number: 1, status: "unreachable" });

    expect(log.read("ses_a").events.map((event) => event.summary)).toEqual([
      undefined,
      undefined,
      { text: "→ slack app_mention", outcome: "timed_out", ok: false },
      { text: "→ slack app_mention (attempt 2)", outcome: "200", ok: true },
      { text: "← slack chat.postMessage", outcome: "200", ok: true },
      { text: "← slack chat.postMessage", outcome: "429 ratelimited", ok: false },
    ]);
    expect(log.read("ses_b").events[0]?.summary).toEqual({ text: "→ slack event", outcome: "unreachable", ok: false });
  });

  test("reads continue from a cursor, and a session's log is gone when it is dropped", () => {
    const log = new EventLog(() => 0, new Redactor());
    log.append("ses_a", "slack", "action", { n: 1 });
    const first = log.read("ses_a");
    log.append("ses_a", "slack", "action", { n: 2 });
    expect(log.read("ses_a", first.cursor).events.map((event) => event.data)).toEqual([{ n: 2 }]);
    log.drop("ses_a");
    expect(log.read("ses_a").events).toEqual([]);
  });
});

describe("a cursor list with a limit", () => {
  test("keeps the newest items, and cursors still count every item", () => {
    const list = new CursorList<number>({ limit: 3 });
    const first = list.read();
    for (const n of [1, 2]) list.append(n);
    const early = list.read(first.cursor);
    expect(early.items).toEqual([1, 2]);
    for (const n of [3, 4, 5]) list.append(n);

    expect(list.read().items).toEqual([3, 4, 5]);
    // On from a cursor that is still in the list: exactly what came after it.
    expect(list.read(early.cursor).items).toEqual([3, 4, 5]);
    // A reader that fell behind (its place was dropped) gets what is left, and goes on from there.
    const behind = list.read(first.cursor);
    expect(behind.items).toEqual([3, 4, 5]);
    list.append(6);
    expect(list.read(behind.cursor).items).toEqual([6]);
  });

  test("the world scope keeps its newest events; a session's log keeps them all", () => {
    const log = new EventLog(() => 0, new Redactor());
    for (let n = 0; n < 10_005; n++) {
      log.append(WORLD_SCOPE, "github", "api_call", { operation: `call ${n}`, responseStatus: 200 });
      log.append("ses_a", "github", "api_call", { operation: `call ${n}`, responseStatus: 200 });
    }
    const world = log.read(WORLD_SCOPE).events;
    expect(world).toHaveLength(10_000);
    expect(world[0]?.data.operation).toBe("call 5");
    expect(log.read("ses_a").events).toHaveLength(10_005);
  });
});
