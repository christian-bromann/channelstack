import { describe, expect, test } from "vitest";

import { LivePlatformRefusal, ProtocolError } from "../errors/index.ts";
import { admitLive, checkOnce, driverReality, forcedReality, personWithoutToken } from "./index.ts";

const SLACK = ["CHANNELSTACK_SLACK_APP_ID", "CHANNELSTACK_SLACK_BOT_TOKEN"];
const backend = { ready: async () => {} };
const both = { CHANNELSTACK_SLACK_APP_ID: "A1", CHANNELSTACK_SLACK_BOT_TOKEN: "xoxb-1" };

/** The code an admission refuses with, or "admitted". */
const outcome = (promise: Promise<void>) =>
  promise.then(
    () => "admitted",
    (error: unknown) => (error instanceof ProtocolError ? error.code : String(error)),
  );

describe("reality rules", () => {
  test("a driver is live with all of its credentials, fake with none", () => {
    expect(driverReality({}, SLACK, backend).mode).toBe("fake");
    expect(driverReality(both, SLACK, backend).mode).toBe("live");
    // A driver that declares nothing is always fake.
    expect(driverReality(both, [], backend).mode).toBe("fake");
  });

  test("some credentials and not all is a setup error, not a quiet fall back to fake", () => {
    const partial = driverReality({ CHANNELSTACK_SLACK_APP_ID: "A1" }, SLACK, backend);
    expect(partial).toEqual({ mode: "missing", missing: ["CHANNELSTACK_SLACK_BOT_TOKEN"] });
    // An empty variable (an unset CI secret) is the same as none.
    expect(driverReality({ ...both, CHANNELSTACK_SLACK_BOT_TOKEN: "" }, SLACK, backend).mode).toBe("missing");
  });

  test("CHANNELSTACK_REALITY: fake wins over credentials; live wants them", () => {
    expect(driverReality({ ...both, CHANNELSTACK_REALITY: "fake" }, SLACK, backend).mode).toBe("fake");
    expect(driverReality({ CHANNELSTACK_REALITY: "live" }, SLACK, backend).mode).toBe("missing");
    expect(forcedReality({})).toBeUndefined();
    expect(() => forcedReality({ CHANNELSTACK_REALITY: "staging" })).toThrow(/must be "fake" or "live"/);
  });

  test("what a live driver lets through, and how it refuses the rest", async () => {
    const live = driverReality(both, SLACK, backend);
    const unbuilt = driverReality(both, SLACK, undefined);
    const missing = driverReality({ CHANNELSTACK_SLACK_APP_ID: "A1" }, SLACK, backend);
    expect(await outcome(admitLive(live, "SlackUser.say", undefined, "slack"))).toBe("admitted");
    expect(await outcome(admitLive(live, "SlackDelivery.retry", { unsupported: "fake only" }, "slack"))).toBe(
      "unsupported_in_live",
    );
    expect(await outcome(admitLive(live, "SlackUser.click", { requires: "browser", reason: "UI" }, "slack"))).toBe(
      "action_requires",
    );
    expect(await outcome(admitLive(unbuilt, "SlackUser.say", undefined, "slack"))).toBe("unsupported_in_live");
    expect(await outcome(admitLive(missing, "SlackUser.say", undefined, "slack"))).toBe("live_misconfigured");
    // The fake lets everything through: its routes never meet these refusals.
    expect(await outcome(admitLive({ mode: "fake" }, "SlackDelivery.retry", { unsupported: "x" }, "slack"))).toBe(
      "admitted",
    );
  });

  test("a live driver's check runs before its first action, and its refusal is the action's", async () => {
    const refused = driverReality(both, SLACK, {
      ready: async () => {
        throw new ProtocolError("live_not_allowlisted", "not here");
      },
    });
    expect(await outcome(admitLive(refused, "SlackUser.say", undefined, "slack"))).toBe("live_not_allowlisted");
  });

  test("a live world's check is kept when definitive, and made again after a failure that will pass", async () => {
    const answers: Array<() => void> = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => {
        throw new LivePlatformRefusal("http_502", "Bad gateway", {}, 502);
      },
      () => {
        throw new LivePlatformRefusal("http_429", "Slow down", {}, 429);
      },
      () => {
        throw new LivePlatformRefusal("missing_access", "Missing Access", {}, 403);
      },
    ];
    let checks = 0;
    const ready = checkOnce(async () => answers[checks++]?.());
    const seen = [];
    for (let attempt = 0; attempt < 5; attempt++) seen.push(await outcome(ready()));
    // A network error, Discord's own failure and a rate limit are asked again; a refusal is kept.
    expect(seen).toEqual(["TypeError: fetch failed", "http_502", "http_429", "missing_access", "missing_access"]);
    expect(checks).toBe(4);

    // A driver's own rule for what will pass, and a check that passes is made once.
    let tries = 0;
    const slack = checkOnce(
      async () => {
        tries++;
        if (tries === 1) throw new LivePlatformRefusal("ratelimited", "Slow down");
      },
      (error) => error.code === "ratelimited",
    );
    expect([await outcome(slack()), await outcome(slack()), await outcome(slack())]).toEqual([
      "ratelimited",
      "admitted",
      "admitted",
    ]);
    expect(tries).toBe(2);
  });

  test("a person without a token in a strict live run names the variable to set", () => {
    const plain = personWithoutToken("Ana", "slack");
    expect(plain.code).toBe("live_misconfigured");
    expect(plain.message).toBe(
      "CHANNELSTACK_REALITY is live and Ana has no token: set CHANNELSTACK_SLACK_USER_<NAME>_TOKEN for them, or run without CHANNELSTACK_REALITY=live",
    );
    expect(personWithoutToken("octocat", "github", { variable: "<LOGIN>" }).message).toContain(
      "CHANNELSTACK_GITHUB_USER_<LOGIN>_TOKEN",
    );
    expect(
      personWithoutToken("Ana", "discord", { lacks: "bot to act as them", as: "a second application's bot token" })
        .message,
    ).toBe(
      "CHANNELSTACK_REALITY is live and Ana has no bot to act as them: set CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN for them to a second application's bot token, or run without CHANNELSTACK_REALITY=live",
    );
  });
});
