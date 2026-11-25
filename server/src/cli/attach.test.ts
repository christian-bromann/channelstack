import { afterEach, expect, test, vi } from "vitest";

import { CONTROL_PREFIX } from "../app.ts";
import { attach } from "./attach.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("a trailing slash on the server's URL doesn't matter", async () => {
  vi.stubEnv("CHANNELSTACK_TOKEN", "test-token");
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ sessionId: "ses_dev" }), { status: 200 });
  });
  const server = attach({ server: "http://127.0.0.1:4500/" });
  expect(server.url).toBe("http://127.0.0.1:4500");
  await server.devSession();
  expect(asked).toEqual([`http://127.0.0.1:4500${CONTROL_PREFIX}/sessions`]);
});
