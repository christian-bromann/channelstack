/**
 * What each animated figure says, in words: its caption on the page (Figures.tsx), and the figure
 * itself in the page's Markdown (plugins/agent-docs.ts), so both say the same thing.
 * A caption is numbered steps that light up with the animation, or a single paragraph. `code`
 * in backticks is set as code.
 */
export type FigureCaption = { steps: readonly string[] } | { text: string };

export const FIGURE_CAPTIONS = {
  RequestFlow: {
    steps: [
      "The test acts as Ana: she mentions the app in a channel.",
      "The fake Slack delivers the event to your app, signed, the way Slack does.",
      "Your app answers through the Slack API it already uses, which now points at the fake.",
      "The matcher reads the thread as Ana would see it, and passes.",
    ],
  },
  SessionScopes: {
    text: "Tests run in parallel against one server. Each test gets its own session: it sees only the people, channels and deliveries it created, and everything goes away when it ends. The CLI, the UI and MCP share one long-lived session called `dev`.",
  },
  QuietWindow: {
    steps: [
      "The check starts watching. The app is still busy: a delivery is in flight, then its API calls, then a stream.",
      "Once nothing is open, the quiet window starts. Anything the app does now restarts it.",
      "After 750 ms of quiet, watched from start to end, the check reads the thread once.",
    ],
  },
  RetryTimeline: {
    steps: [
      "Slack delivers the event. Without an answer within 3 seconds it counts the delivery as failed.",
      "It sends the same event again, with the attempt number and the reason in its retry headers.",
      "An app that remembers the event id acknowledges the retry and does nothing else.",
      "The thread gets one reply. An app that doesn't check answers twice.",
    ],
  },
  ProxyRouting: {
    steps: [
      "The app calls the platform's real host. The proxy in its environment takes the connection.",
      "slack.com, api.github.com, api.linear.app, api.notion.com, api.resend.com, Google's googleapis.com, discord.com, gateway.discord.gg and api.openai.com hosts go to the fakes, under a certificate only the app trusts.",
      "The fakes answer exactly as they do on *.localhost.",
      "Every other host, such as your error tracker's, passes through untouched.",
    ],
  },
  FakeOrLive: {
    text: "The test doesn't change. Credentials in the environment decide whether it runs against the fake or the real platform.",
  },
} as const satisfies Record<string, FigureCaption>;

export type FigureName = keyof typeof FIGURE_CAPTIONS;
