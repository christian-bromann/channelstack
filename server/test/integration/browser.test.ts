import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { BrowserActor } from "../../src/core/browser/index.ts";

/**
 * The browser actor in a real headless Chrome (WebdriverIO over BiDi), against a local page that
 * stands in for a chat client: a composer that sends on Enter, and a button. It proves the actor's
 * own mechanics (a restored session, opening, clicking, typing, Enter); Slack's selectors are
 * proved only against Slack, nightly.
 */
const PAGE = `<!doctype html><meta charset="utf-8">
<div data-qa="message_input"><div contenteditable="true" id="composer" style="min-height:2em;border:1px solid"></div></div>
<button onclick="fetch('/clicked', { method: 'POST' })">Approve</button>
<script>
  document.getElementById("composer").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    fetch("/sent", { method: "POST", body: event.target.innerText });
    event.target.innerText = "";
  });
</script>`;

let server: Server;
let origin = "";
const seen: Array<{ path: string; body: string; cookie: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      if (request.method === "POST") seen.push({ path: request.url ?? "", body, cookie: request.headers.cookie });
      response.writeHead(200, { "content-type": "text/html" }).end(request.method === "GET" ? PAGE : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 50 && !done(); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
};

describe("the browser actor in Chrome", () => {
  test("restores a saved session, types and sends, clicks, and opens only its own origins", async () => {
    const actor = await BrowserActor.start({
      origins: [origin],
      state: { cookies: [{ name: "d", value: "signed-in", domain: "127.0.0.1", path: "/" }] },
    });
    try {
      await actor.open(`${origin}/client/T1/C1`);
      await actor.click('[data-qa="message_input"] [contenteditable="true"]');
      await actor.type("hello there");
      await actor.press("Enter");
      await actor.click('(//button[normalize-space(.)="Approve"])[last()]');
      await until(() => seen.length >= 2);
      expect(seen).toEqual([
        { path: "/sent", body: "hello there", cookie: "d=signed-in" },
        { path: "/clicked", body: "", cookie: "d=signed-in" },
      ]);
      await expect(actor.open("https://example.com/")).rejects.toThrow(/opens only/);
      expect((await actor.state(["127.0.0.1"])).cookies.map((cookie) => cookie.name)).toEqual(["d"]);
    } finally {
      await actor.close();
    }
  }, 60_000);
});
