import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { classify, diff, expired, loadDivergences, normalize } from "./lib.ts";

const yaml = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), "channelstack-divergences-"));
  const file = join(dir, "divergences.yaml");
  writeFileSync(file, text);
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
};

describe("exit check 6.4: the differential run's comparison", () => {
  test("normalizing drops ids, times, links and account names, and keeps structure, order and text", () => {
    const fake = {
      ts: "1700000000.000100",
      author: { kind: "app", id: "U0AGENT0001", name: "my-agent" },
      text: "<@U0ANA000001> here: https://acme.slack.com/archives/C0SUPPORT1",
      postedAt: "2026-11-24T10:00:00.000Z",
      delivery: { id: "ED1", status: "acknowledged" },
      replies: [{ text: "one" }, { text: "two" }],
    };
    const live = {
      ts: "1764000000.123456",
      author: { kind: "app", id: "U09ROBIN123", name: "robin" },
      text: "<@U07ANAREAL1> here: https://channelstack.slack.com/archives/C09ABCDEF12",
      postedAt: "2026-11-25T03:12:44.000Z",
      replies: [{ text: "one" }, { text: "two" }],
    };
    expect(normalize(fake)).toEqual(normalize(live));
    expect(normalize(fake)).toEqual({
      author: { kind: "app" },
      text: "<@id> here: <url>",
      replies: [{ text: "one" }, { text: "two" }],
    });
  });

  test("a mention is @mention whoever it names, an issue key is <issue>, and no secret survives", () => {
    const fake = {
      comments: [
        { author: { kind: "user", name: "Ana" }, text: "@my-agent summarize this page" },
        {
          author: { kind: "app", name: "my-agent", token: "ntn_fake", webhookSecret: "s", privateKey: "k" },
          text: "Done",
        },
      ],
    };
    const live = {
      comments: [
        { author: { kind: "user", name: "Ana" }, text: "@robin summarize this page" },
        { author: { kind: "app", name: "robin", token: "" }, text: "Done" },
      ],
    };
    expect(diff(normalize(fake), normalize(live))).toEqual([]);
    expect(JSON.stringify(normalize(fake))).not.toMatch(/ntn_fake|webhookSecret|privateKey|token/);
    expect((normalize(fake) as { comments: Array<{ text: string }> }).comments[0]?.text).toBe(
      "@mention summarize this page",
    );
    expect(normalize("Work on [ENG-12](https://linear.app/acme/issue/ENG-12)")).toBe("Work on [<issue>](<url>)");
  });

  test("Discord's snowflakes are ids, alone or in a mention, and its app's public key is how the app is set up", () => {
    const fake = {
      channelId: "1575937482757767444",
      content: "<@204772274377444028> hi",
      author: { publicKey: "4404" },
    };
    const live = { channelId: "1575937502433251350", content: "<@1575928936762843407> hi", author: { publicKey: "" } };
    expect(diff(normalize(fake), normalize(live))).toEqual([]);
    expect(normalize(fake)).toEqual({ channelId: "<id>", content: "<@<id>> hi", author: {} });
  });

  test("a result never holds a secret field or an email, whatever a recording had", () => {
    const recording = {
      author: { kind: "app", token: "ntn_x", privateKey: "k", signingSecret: "s", password: "p" },
      text: "Ping ana@example.com or ana.b+test@sub.example.org",
    };
    const normalized = JSON.stringify(normalize(recording));
    expect(normalized).not.toMatch(/token|privateKey|signingSecret|password|ntn_x|@example/);
    expect(normalized).toContain("Ping <email> or <email>");
  });

  test("a difference is found by its path: in text, in kind, and in a list's length", () => {
    const fake = normalize({ replies: [{ author: { kind: "app" }, text: "Here's the summary" }] });
    expect(diff(fake, normalize({ replies: [{ author: { kind: "app" }, text: "Here's the summary" }] }))).toEqual([]);
    expect(diff(fake, normalize({ replies: [{ author: { kind: "user" }, text: "Here's a summary" }] }))).toEqual([
      { path: "replies.0.author.kind", fake: "app", live: "user" },
      { path: "replies.0.text", fake: "Here's the summary", live: "Here's a summary" },
    ]);
    expect(diff(fake, normalize({ replies: [] }))).toEqual([{ path: "replies.length", fake: 1, live: 0 }]);
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual([{ path: "b", fake: undefined, live: 2 }]);
  });

  test("a divergence with a reason and a date allows its difference until it expires; then it fails again", () => {
    const { file, done } = yaml(`divergences:
  - scenario: slack/mention
    path: replies.*
    reason: Slack adds an attachment the fake doesn't.
    expires: 2027-01-31
`);
    try {
      const divergences = loadDivergences(file);
      const differences = [
        { path: "replies.0.blocks.length", fake: 0, live: 1 },
        { path: "question.text", fake: "a", live: "b" },
      ];
      const before = classify("slack/mention", differences, divergences, "2026-11-24");
      expect(before.map((difference) => difference.allowedBy?.reason)).toEqual([
        "Slack adds an attachment the fake doesn't.",
        undefined,
      ]);
      expect(classify("github/triage", differences, divergences, "2026-11-24").every((d) => !d.allowedBy)).toBe(true);
      // After its date, nothing is allowed, and the check names it.
      expect(classify("slack/mention", differences, divergences, "2027-02-01").every((d) => !d.allowedBy)).toBe(true);
      expect(expired(divergences, "2027-02-01")).toHaveLength(1);
      expect(expired(divergences, "2027-01-31")).toHaveLength(0);
    } finally {
      done();
    }
  });

  test("a divergence without a reason, or without a real date, is refused", () => {
    for (const [text, message] of [
      ["divergences:\n  - { scenario: a, path: b, expires: 2027-01-01 }\n", /has no reason/],
      ["divergences:\n  - { scenario: a, path: b, reason: why, expires: soon }\n", /not a YYYY-MM-DD date/],
      ["divergences: nope\n", /must be a list/],
    ] as const) {
      const { file, done } = yaml(text);
      try {
        expect(() => loadDivergences(file)).toThrow(message);
      } finally {
        done();
      }
    }
  });

  test("the repository's divergences.yaml is valid, and nothing in it has expired", () => {
    const divergences = loadDivergences(join(import.meta.dirname, "divergences.yaml"));
    expect(expired(divergences, new Date().toISOString().slice(0, 10))).toEqual([]);
  });
});

describe("exit check 6.4: the shape differ", () => {
  test("it reports what the platform sends that the fake doesn't, and types with nothing in common", async () => {
    const { compareShapes } = await import("./shapes.ts");
    expect(compareShapes({ ok: "=true", ts: "string" }, { ok: "=true", ts: "string" })).toEqual([]);
    expect(
      compareShapes(
        { ok: "=true", message: { text: "string" }, extra: "string" },
        { ok: "=true", message: { text: "string", blocks: [] }, warning: "string" },
      ),
    ).toEqual([
      { path: "message.blocks", fake: undefined, live: [] },
      { path: "warning", fake: undefined, live: "string" },
    ]);
    expect(compareShapes({ count: "number" }, { count: "string" })).toEqual([
      { path: "count", fake: "number", live: "string" },
    ]);
    // Kept codes are compared: an event type or an error code the fake never sends is a difference.
    expect(compareShapes({ type: "=message|=app_mention" }, { type: "=message" })).toEqual([]);
    // A code only the platform sends is a difference, even next to one both send.
    expect(compareShapes({ type: "=message" }, { type: "=message|=app_mention" })).toEqual([
      { path: "type", fake: "=message", live: "=app_mention" },
    ]);
    expect(compareShapes({ error: "=not_in_channel" }, { error: "=channel_not_found" })).toEqual([
      { path: "error", fake: "=not_in_channel", live: "=channel_not_found" },
    ]);
    expect(compareShapes({ type: "string" }, { type: "=message" })).toEqual([]);
    // A null now and then, or a list empty on one side, says nothing.
    expect(compareShapes({ next: "string" }, { next: "null|string" })).toEqual([]);
    expect(compareShapes({ items: [] }, { items: [{ id: "string" }] })).toEqual([]);
  });

  test("recordings are read per operation, merged, and a refusal is its own operation", async () => {
    const { readShapes } = await import("./shapes.ts");
    const dir = mkdtempSync(join(tmpdir(), "channelstack-shapes-"));
    try {
      const file = join(dir, "shapes.jsonl");
      const line = (value: object) => `${JSON.stringify(value)}\n`;
      writeFileSync(
        file,
        line({
          kind: "api",
          channel: "slack",
          operation: "POST /api/chat.postMessage",
          status: 200,
          shape: { ok: "=true", ts: "string" },
        }) +
          line({
            kind: "api",
            channel: "slack",
            operation: "POST /api/chat.postMessage",
            status: 200,
            shape: { ok: "=true", channel: "string" },
          }) +
          line({
            kind: "api",
            channel: "slack",
            operation: "POST /api/chat.postMessage",
            status: 200,
            shape: { ok: "=false", error: "=not_in_channel" },
          }) +
          line({ kind: "webhook", channel: "github", operation: "issues", shape: { action: "=opened" } }),
      );
      expect(Object.fromEntries(readShapes([file, join(dir, "missing.jsonl")]))).toEqual({
        "api slack POST /api/chat.postMessage": { ok: "=true", ts: "string", channel: "string" },
        "api slack POST /api/chat.postMessage refused": { ok: "=false", error: "=not_in_channel" },
        "webhook github issues": { action: "=opened" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
