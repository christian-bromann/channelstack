import type { CapabilityTable } from "../../core/router/index.ts";

const fakeOnly = { fake: true, live: false, liveRequires: [] };

/** Echo has no real platform behind it, so every action is fake-only. */
export const capabilities: CapabilityTable = {
  createUser: fakeOnly,
  createRoom: fakeOnly,
  say: fakeOnly,
  messages: fakeOnly,
  transcript: fakeOnly,
};
