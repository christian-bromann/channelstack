// A stand-in for Slack's reference agent: Bolt as the reference agents import it, handed one event
// by hand (no network: `authorize` answers without asking Slack). Says "handled" when its listener ran.
import { App } from "@slack/bolt";

const app = new App({
  signingSecret: "stand-in",
  authorize: async () => ({ botToken: "xoxb-stand-in", botId: "B0STANDIN", botUserId: "U0STANDIN" }),
});
app.event("app_mention", async ({ event }) => {
  console.log(`handled ${event.text}`);
});
// A moment first, so a parent that closes the IPC channel at once has closed it by now.
await new Promise((resolve) => setTimeout(resolve, 200));
await app.processEvent({
  body: {
    type: "event_callback",
    team_id: "T0STANDIN",
    api_app_id: "A0STANDIN",
    event: { type: "app_mention", text: "hi", user: "U0PERSON", channel: "C0STANDIN", ts: "1.2" },
  },
  ack: async () => {},
} as never);
