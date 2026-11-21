export const SITE = {
  name: "channelstack",
  url: "https://channelstack.dev",
  title: "channelstack: test your chat agent on localhost",
  /** Shown in search results and link previews; kept under 160 characters so it isn't cut off. */
  description:
    "Test AI agents that live in Slack, GitHub, Linear and Notion. channelstack fakes the platforms on localhost: script the people, assert on what they'd see.",
  repo: "https://github.com/christian-bromann/channelstack",
  install: "npm i -D channelstack",
} as const;
