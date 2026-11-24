/**
 * The Bolt app the Bolt reference agents start from, configured from the environment the way
 * `channelstack env` prints it. It talks to whatever `SLACK_API_URL` points at: the fake in
 * tests, Slack itself when the variable is unset.
 */
import { App, type AppOptions, LogLevel } from "@slack/bolt";

const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN, SLACK_API_URL, SLACK_SOCKET_MODE, PORT } = process.env;
/** With `SLACK_SOCKET_MODE=1` the app connects out to Slack over a WebSocket and needs no public URL. */
const socketMode = SLACK_SOCKET_MODE === "1";
if (!SLACK_BOT_TOKEN || (socketMode ? !SLACK_APP_TOKEN : !SLACK_SIGNING_SECRET || !PORT)) {
  throw new Error(
    socketMode
      ? "The agent needs SLACK_BOT_TOKEN and SLACK_APP_TOKEN"
      : "The agent needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and PORT",
  );
}

/** A Bolt app pointed at Slack, or at the fake. `overrides` are Bolt's own options, for an agent that needs them. */
export const createApp = (overrides: Partial<AppOptions> = {}): App =>
  new App({
    token: SLACK_BOT_TOKEN,
    ...(socketMode
      ? { socketMode: true, appToken: SLACK_APP_TOKEN ?? "" }
      : { signingSecret: SLACK_SIGNING_SECRET ?? "" }),
    ...(SLACK_API_URL ? { clientOptions: { slackApiUrl: SLACK_API_URL } } : {}),
    logLevel: LogLevel.ERROR,
    ...overrides,
  });

/** Start: listen on `PORT`, or in Socket Mode, connect. Says so once it is, as Bolt's own examples do. */
export const listen = async (app: App) => {
  await (socketMode ? app.start() : app.start(Number(PORT)));
  console.log("⚡️ Bolt app is running");
};
