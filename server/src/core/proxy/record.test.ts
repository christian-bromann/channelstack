import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createRecorder, forward, mergeShapes, operationOf, shapeOf } from "./record.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the recorder", () => {
  test("a shape keeps structure and codes, never a value", () => {
    const shape = shapeOf({
      ok: true,
      error: "channel_not_found",
      channel: "C0123456789",
      message: { type: "message", text: "Ana's email is ana@example.com", user: "U0ANA", ts: "1.2", reactions: [] },
      response_metadata: { scopes: ["chat:write"] },
      count: 2,
      next: null,
    });
    expect(shape).toEqual({
      ok: "=true",
      error: "=channel_not_found",
      channel: "string",
      message: { type: "=message", text: "string", user: "string", ts: "string", reactions: [] },
      response_metadata: { scopes: ["string"] },
      count: "number",
      next: "null",
    });
    expect(JSON.stringify(shape)).not.toMatch(/ana@example\.com|C0123456789|U0ANA|chat:write/);
  });

  test("shapes merge: every key either has, and both types where they differ", () => {
    expect(mergeShapes({ a: "string", b: "number" }, { a: "null", c: ["string"] })).toEqual({
      a: "null|string",
      b: "number",
      c: ["string"],
    });
    expect(shapeOf([{ a: 1 }, { b: "x" }])).toEqual([{ a: "number", b: "string" }]);
    // Keys that are ids (Google's certificates by key id) are one key, whichever ids they are.
    expect(shapeOf({ ["9e7b".repeat(10)]: "pem", ["943a".repeat(10)]: "pem", other: 1 })).toEqual({
      "<id>": "string",
      other: "number",
    });
  });

  test("an operation is its path without ids, or a GraphQL operation's name", () => {
    expect(operationOf("post", "/api/chat.postMessage", "")).toBe("POST /api/chat.postMessage");
    expect(operationOf("GET", "/repos/Channelstack-dev/channelstack-run-gh1-1/issues/12/comments", "")).toBe(
      "GET /repos/{owner}/{repo}/issues/{n}/comments",
    );
    expect(operationOf("GET", "/orgs/acme/repos", "")).toBe("GET /orgs/{org}/repos");
    expect(operationOf("PATCH", "/v1/pages/422e2f9d-c3a4-8017-8f2b-e67722e4c3f5", "")).toBe("PATCH /v1/pages/{id}");
    expect(operationOf("POST", "/graphql", JSON.stringify({ query: "mutation IssueCreate($input: X) { a }" }))).toBe(
      "POST /graphql IssueCreate",
    );
    expect(
      operationOf("POST", "/graphql", JSON.stringify({ operationName: "viewer", query: "{ viewer { id } }" })),
    ).toBe("POST /graphql viewer");
  });

  test("an exchange is answered as it was, and only its shape is written, to a private file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "channelstack-record-"));
    dirs.push(dir);
    const recorder = createRecorder(dir);
    const response = await recorder.exchange(
      "slack",
      new Request("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: "Bearer xoxb-secret" },
        body: JSON.stringify({ channel: "C1", text: "hello" }),
      }),
      async () => Response.json({ ok: true, ts: "1.2", message: { text: "hello" } }),
    );
    expect(await response.json()).toEqual({ ok: true, ts: "1.2", message: { text: "hello" } });
    recorder.webhook("github", "issue_comment", JSON.stringify({ action: "created", comment: { body: "hi" } }));
    // Slack's events by the event's type, and its interactions from the form they come in.
    recorder.webhook(
      "slack",
      "event_callback",
      JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "hi" } }),
    );
    recorder.webhook(
      "slack",
      "event_callback",
      JSON.stringify({ type: "event_callback", event: { type: "message", subtype: "channel_join", text: "hi" } }),
    );
    recorder.webhook(
      "slack",
      "block_actions",
      new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          actions: [{ value: "hi" }],
          // Block ids an app built from what a person typed: never written.
          state: {
            values: {
              "deploy:checkout": { approve: { type: "button", value: "yes" } },
              "deploy:billing": { reason: { type: "plain_text_input", value: "late" } },
            },
          },
        }),
      }).toString(),
    );
    const file = join(dir, "shapes.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      {
        kind: "api",
        channel: "slack",
        operation: "POST /api/chat.postMessage",
        status: 200,
        shape: { ok: "=true", ts: "string", message: { text: "string" } },
      },
      {
        kind: "webhook",
        channel: "github",
        operation: "issue_comment created",
        shape: { action: "=created", comment: { body: "string" } },
      },
      {
        kind: "webhook",
        channel: "slack",
        operation: "event_callback app_mention",
        shape: { type: "=event_callback", event: { type: "=app_mention", text: "string" } },
      },
      {
        kind: "webhook",
        channel: "slack",
        operation: "event_callback message channel_join",
        shape: { type: "=event_callback", event: { type: "=message", subtype: "=channel_join", text: "string" } },
      },
      {
        kind: "webhook",
        channel: "slack",
        operation: "block_actions",
        shape: {
          type: "=block_actions",
          actions: [{ value: "string" }],
          state: {
            values: { "{block_id}": { "{action_id}": { type: "=button|=plain_text_input", value: "string" } } },
          },
        },
      },
    ]);
    expect(readFileSync(file, "utf8")).not.toMatch(/xoxb-secret|hello|"hi"|deploy:|approve|reason|late/);
  });

  test("forwarding passes the request on to the platform's own host, as it was", async () => {
    const sent: Array<{ url: string; method: string; auth: string | null; host: string | null; body: string }> = [];
    const answer = await forward(
      new Request("https://slack.com/api/auth.test?x=1", {
        method: "POST",
        headers: { authorization: "Bearer xoxb-1", "proxy-connection": "keep-alive" },
        body: "token=1",
      }),
      async (url, init) => {
        const headers = new Headers(init?.headers);
        sent.push({
          url: String(url),
          method: String(init?.method),
          auth: headers.get("authorization"),
          host: headers.get("proxy-connection"),
          body: new TextDecoder().decode(init?.body as ArrayBuffer),
        });
        return Response.json({ ok: true }, { status: 200, headers: { "content-encoding": "gzip" } });
      },
    );
    expect(sent).toEqual([
      {
        url: "https://slack.com/api/auth.test?x=1",
        method: "POST",
        auth: "Bearer xoxb-1",
        host: null,
        body: "token=1",
      },
    ]);
    expect(answer.headers.get("content-encoding")).toBeNull();
    expect(await answer.json()).toEqual({ ok: true });
  });
});
