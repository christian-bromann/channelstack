import { describe, expect, test } from "vitest";

import { coveragePage, coverageRows, coverageSummary } from "./coverage.ts";
import type { ConformanceResults } from "./lib.ts";

const spec = {
  paths: {
    "/sessions/{session}/slack/users/{user}/say": {
      post: { "x-channelstack-method": { on: "SlackUser", name: "say" } },
    },
    "/sessions/{session}/slack/users/{user}/select": {
      post: {
        "x-channelstack-method": { on: "SlackUser", name: "select" },
        "x-channelstack-live": { requires: "browser", reason: "only a person does it in the client" },
      },
    },
    "/sessions/{session}/github/deliveries/{delivery}/redeliver": {
      post: {
        "x-channelstack-method": { on: "GitHubDelivery", name: "forgeSignature" },
        "x-channelstack-live": { unsupported: "delivery chaos is fake only" },
      },
    },
    "/status": { get: { "x-channelstack-method": { on: "Channelstack", name: "status" } } },
  },
};
const results: ConformanceResults = {
  at: "2026-11-24T03:00:00.000Z",
  live: true,
  expired: [],
  shapes: [],
  scenarios: [
    {
      scenario: "slack/mention",
      channel: "slack",
      fake: "passed",
      live: "passed",
      differences: [
        {
          path: "replies.0.blocks.length",
          fake: 0,
          live: 1,
          allowedBy: {
            scenario: "slack/mention",
            path: "replies.*",
            reason: "Slack adds a block",
            expires: "2027-01-01",
          },
        },
      ],
    },
  ],
};
const scenarios = [
  { name: "slack/mention", channel: "slack", covers: ["SlackUser.say"], calls: ["createUser", "say"] },
];

describe("exit check 6.5: the coverage page", () => {
  test("each action of each channel, how it works live, and when fake and live last agreed on it", () => {
    expect(coverageRows({ spec, divergences: [], scenarios, results })).toEqual([
      {
        channel: "slack",
        action: "SlackUser.say",
        live: "Works",
        agreed: "Agreed on 2026-11-24 (slack/mention, 1 known divergence)",
      },
      {
        channel: "slack",
        action: "SlackUser.select",
        live: "Needs the browser actor: only a person does it in the client",
        agreed: "Not covered by a scenario",
      },
      {
        channel: "github",
        action: "GitHubDelivery.forgeSignature",
        live: "Fake only: delivery chaos is fake only",
        agreed: "Not covered by a scenario",
      },
    ]);
  });

  test("a scenario that differed or wasn't run live says so", () => {
    const differed: ConformanceResults = {
      ...results,
      scenarios: [{ ...results.scenarios[0]!, differences: [{ path: "replies.0.text", fake: "a", live: "b" }] }],
    };
    expect(coverageRows({ spec, divergences: [], scenarios, results: differed })[0]?.agreed).toBe(
      "Differed on 2026-11-24 (slack/mention)",
    );
    const skipped: ConformanceResults = {
      ...results,
      scenarios: [{ ...results.scenarios[0]!, live: "skipped", differences: [] }],
    };
    expect(coverageRows({ spec, divergences: [], scenarios, results: skipped })[0]?.agreed).toBe(
      "Not run live (slack/mention)",
    );
  });

  test("the page escapes what it shows, and lists the divergences with their reasons and dates", () => {
    const page = coveragePage({
      spec,
      scenarios,
      results,
      divergences: [
        { scenario: "slack/mention", path: "replies.*", reason: "Slack adds <b>a block</b>", expires: "2027-01-01" },
      ],
    });
    expect(page).toContain("<title>channelstack coverage</title>");
    expect(page).toContain("Slack adds &#60;b&#62;a block&#60;/b&#62;");
    expect(page).not.toContain("<b>a block</b>");
    expect(page).toContain("2027-01-01");
    expect(page).toContain("The latest differential run ended 2026-11-24T03:00:00.000Z.");
    expect(coveragePage({ spec, scenarios, divergences: [] })).toContain(
      "No differential run's results were given to this build.",
    );
  });

  test("the job summary: per channel, its actions, how many work live, and how many agreed", () => {
    const summary = coverageSummary({ spec, divergences: [], scenarios, results });
    expect(summary).toContain("| slack | 2 | 1 | 1 |");
    expect(summary).toContain("| github | 1 | 0 | 0 |");
    expect(summary).toContain("The differential run ended 2026-11-24T03:00:00.000Z.");
  });

  test("a scenario is credited only with the actions it names, and a name the spec doesn't have is refused", () => {
    // `select` on the same type isn't `say`: only what a scenario names is credited.
    const other = [{ name: "slack/mention", channel: "slack", covers: ["SlackUser.select"], calls: ["select"] }];
    expect(coverageRows({ spec, divergences: [], scenarios: other, results })[0]?.agreed).toBe(
      "Not covered by a scenario",
    );
    expect(() =>
      coverageRows({
        spec,
        divergences: [],
        scenarios: [{ name: "x", channel: "slack", covers: ["SlackUser.sya"], calls: ["sya"] }],
        results,
      }),
    ).toThrow(/SlackUser\.sya/);
    // An action the spec has, but no step calls, isn't covered either.
    expect(() =>
      coverageRows({
        spec,
        divergences: [],
        scenarios: [{ name: "y", channel: "slack", covers: ["SlackUser.say"], calls: ["createUser"] }],
        results,
      }),
    ).toThrow(/no step of it calls/);
  });
});
