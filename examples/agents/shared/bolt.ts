/**
 * The Bolt app the Bolt reference agents start from, configured from the environment the way
 * `channelstack env` prints it. It talks to whatever `SLACK_API_URL` points at: the fake in
 * tests, Slack itself when the variable is unset.
 */
import { App, LogLevel } from "@slack/bolt";

const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_API_URL, PORT } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !PORT) {
  throw new Error("The agent needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and PORT");
}

export const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  ...(SLACK_API_URL ? { clientOptions: { slackApiUrl: SLACK_API_URL } } : {}),
  logLevel: LogLevel.ERROR,
});

/** Start listening on `PORT`. */
export const listen = () => app.start(Number(PORT));
