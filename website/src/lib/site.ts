export const SITE = {
  name: "channelstack",
  url: "https://channelstack.dev",
  title: "channelstack: test your Slack, GitHub, Linear, Notion and Resend apps on localhost",
  /** Shown in search results and link previews; kept under 160 characters so it isn't cut off. */
  description:
    "Test your Slack, GitHub, Linear, Notion and Resend apps and agents on localhost. channelstack fakes the platforms: script the people, assert on what they see.",
  repo: "https://github.com/christian-bromann/channelstack",
  install: "npm i -D channelstack",
} as const;
