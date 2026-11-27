/**
 * Attributing a request that names no session (exit check 13.5): each kind of evidence, strongest
 * first, strings several sessions share never deciding, and order between sessions that sent the
 * same text.
 */
import { describe, expect, test } from "vitest";

import { Attributor, bodyStrings, type KnownString, normalise } from "./index.ts";

/** Sessions and what each knows, as the app would read them from deliveries and API answers. */
function world(known: Record<string, Array<string | (Partial<KnownString> & { text: string })>>) {
  return new Attributor({
    sessions: () => Object.keys(known),
    known: (session) =>
      (known[session] ?? []).map((item, at) =>
        typeof item === "string"
          ? { text: item, driver: "slack", delivery: `${session}-${at}`, at }
          : { driver: "slack", at, ...item },
      ),
  });
}

const request = (text: string, extra: { minted?: string[]; tags?: string[] } = {}) => ({
  minted: extra.minted ?? [],
  tags: extra.tags ?? [],
  text,
});

describe("the evidence, strongest first", () => {
  test("an id the fake minted for a session's answer decides, whatever else the request says", () => {
    const attributor = world({ ses_a: ["what broke in the web deploy?"], ses_b: ["the migration step failed"] });
    attributor.mint("ses_b", ["call_123"]);

    const found = attributor.attribute(request("what broke in the web deploy?", { minted: ["call_123"] }));

    expect(found).toMatchObject({ session: "ses_b", by: "minted_id", matched: "call_123" });
  });

  test("a tag the agent sent: a session id, or a string only one session knows", () => {
    const attributor = world({ ses_a: ["U08B5K2M9QX"], ses_b: ["U08C9D1E2F3"] });

    expect(attributor.attribute(request("hello", { tags: ["ses_b"] }))).toMatchObject({ session: "ses_b", by: "tag" });
    expect(attributor.attribute(request("hello", { tags: ["U08B5K2M9QX"] }))).toMatchObject({
      session: "ses_a",
      by: "tag",
    });
  });

  test("an id only one session owns, found in the prompt", () => {
    const attributor = world({ ses_a: ["C08E1F2G3H4"], ses_b: ["C08F2G3H4J5"] });

    expect(attributor.attribute(request("Summarise channel C08F2G3H4J5 for me"))).toMatchObject({
      session: "ses_b",
      by: "owned_id",
    });
  });

  test("what a session's person wrote, with mentions and case set aside", () => {
    const attributor = world({
      ses_a: ["<@U08AGENT01> what broke yesterday?"],
      ses_b: ["<@U08AGENT01> write the release notes"],
    });

    const found = attributor.attribute(request("system: be brief\nuser: @my-agent WHAT BROKE YESTERDAY?"));

    expect(found).toMatchObject({ session: "ses_a", by: "text", matched: "what broke yesterday?" });
  });

  test("strings every session has (the workspace, the app's name) never decide", () => {
    const attributor = world({ ses_a: ["T08A1B2C3D4", "my-agent-app"], ses_b: ["T08A1B2C3D4", "my-agent-app"] });

    expect(attributor.attribute(request("T08A1B2C3D4 my-agent-app"))).toBeUndefined();
  });

  test("short text decides nothing", () => {
    const attributor = world({ ses_a: ["hi"], ses_b: ["thanks"] });

    expect(attributor.attribute(request("hi"))).toBeUndefined();
  });
});

describe("two sessions sent the same text", () => {
  test("the oldest unanswered message gets the call, and the next one goes to the other", () => {
    const attributor = world({
      ses_a: [{ text: "@my-agent how's my change doing?", delivery: "d_a", at: 1 }],
      ses_b: [{ text: "@my-agent how's my change doing?", delivery: "d_b", at: 2 }],
    });

    const first = attributor.attribute(request("how's my change doing?"));
    const second = attributor.attribute(request("how's my change doing?"));

    expect(first).toMatchObject({ session: "ses_a", by: "order", tiedWith: ["ses_b"] });
    expect(second).toMatchObject({ session: "ses_b", by: "order", tiedWith: ["ses_a"] });
  });

  test("something only one of them has still decides", () => {
    const attributor = world({
      ses_a: ["@my-agent how's my change doing?", "U08B5K2M9QX"],
      ses_b: ["@my-agent how's my change doing?", "U08C9D1E2F3"],
    });

    expect(attributor.attribute(request("U08C9D1E2F3: how's my change doing?"))).toMatchObject({
      session: "ses_b",
      by: "owned_id",
    });
  });
});

describe("reading what a session knows", () => {
  test("a delivery's body: JSON, its nested strings, and a form's JSON payload", () => {
    expect(bodyStrings(JSON.stringify({ event: { user: "U08B5K2M9QX", text: "hi there friend" } }))).toEqual([
      "U08B5K2M9QX",
      "hi there friend",
    ]);
    expect(bodyStrings(`payload=${encodeURIComponent(JSON.stringify({ user: { id: "U08B5K2M9QX" } }))}`)).toEqual([
      "U08B5K2M9QX",
    ]);
  });

  test("text is compared without mentions, links' brackets, extra whitespace or case", () => {
    expect(normalise("<@U08B5K2M9QX>  Deploy   <https://example.com|the page> NOW")).toBe(
      "deploy https://example.com now",
    );
  });

  test("a closed session's minted ids are forgotten", () => {
    const attributor = world({ ses_a: [] });
    attributor.mint("ses_a", ["call_1"]);
    attributor.forget("ses_a");

    expect(attributor.attribute(request("anything at all here", { minted: ["call_1"] }))).toBeUndefined();
  });
});
