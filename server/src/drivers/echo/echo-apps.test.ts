/**
 * Exit check 12.6 for echo, the reference channel: two apps answering each other in a room trip
 * the loop guard (decision 0027), which stops the deliveries, records `bot_loop`, and names the
 * loop to the session's quiet check, until a person writes there again.
 */
import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";
import { LOOP_LIMIT } from "../../core/loops/index.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

describe("exit check 12.6: echo apps", () => {
  test("two apps answering each other are stopped at the guard's limit, and the session says so", async () => {
    const mine = await recordingAgent();
    agents.push(mine);
    const h = harness({ echo: mine.url });
    const { sessionId } = (await h.call("POST", "/sessions")).body;
    const post = async (path: string, body?: unknown) => {
      const response = await h.call("POST", `/sessions/${sessionId}/echo${path}`, body);
      if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
      return response.body;
    };
    const { app } = (await h.call("GET", `/sessions/${sessionId}/echo`)).body;
    const coder = await post("/apps", { name: "coder" });
    const reviewer = await post("/apps", { name: "reviewer" });
    const ana = await post("/users", { name: "Ana" });
    const room = await post("/rooms", { participants: [ana.id, app.id, coder.id, reviewer.id] });
    const other = await post("/rooms", { participants: [ana.id, app.id, coder.id] });

    await post(`/users/${ana.id}/say`, { text: "go", room: room.id });
    for (let i = 0; i < LOOP_LIMIT + 5; i++) {
      await post(`/apps/${i % 2 === 0 ? coder.id : reviewer.id}/say`, { text: `turn ${i}`, room: room.id });
    }
    await h.app.settled();
    const inRoom = (id: string) =>
      mine.received.filter((delivery) => JSON.parse(delivery.body).message?.room === id).length;

    // my-agent heard Ana, then each app message up to the limit, and nothing after.
    expect(inRoom(room.id)).toBe(1 + LOOP_LIMIT);
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([
      expect.stringMatching(/^a bot loop in echo \S+ was stopped after 50 app messages .*coder → reviewer/),
    ]);
    const { events } = (await h.call("GET", `/sessions/${sessionId}/events`)).body as {
      events: Array<{ kind: string; data: Record<string, unknown> }>;
    };
    expect(events.filter((event) => event.kind === "bot_loop").map((event) => event.data)).toEqual([
      { conversation: room.id, messages: LOOP_LIMIT, authors: ["coder", "reviewer"] },
    ]);

    // Another room goes on, and a person writing again starts the stopped one over.
    await post(`/apps/${coder.id}/say`, { text: "elsewhere", room: other.id });
    await post(`/users/${ana.id}/say`, { text: "again", room: room.id });
    await post(`/apps/${coder.id}/say`, { text: "back", room: room.id });
    await h.app.settled();
    expect(inRoom(other.id)).toBe(1);
    expect(inRoom(room.id)).toBe(3 + LOOP_LIMIT);
  });
});
