import sdk from "../../../sdks/typescript/package.json";

/** The released version: every package carries it, and a release sets it (docs/release.md). */
const VERSION = sdk.version;

export const SITE = {
  name: "channelstack",
  url: "https://channelstack.dev",
  title: "channelstack: test your Slack, GitHub, Linear, Notion, Resend, Gmail and Discord apps on localhost",
  /** Shown in search results and link previews; kept under 160 characters so it isn't cut off. */
  description:
    "Test your Slack, GitHub, Linear, Notion, email and Discord apps on localhost. channelstack fakes the platforms: script the people, assert on what they see.",
  repo: "https://github.com/christian-bromann/channelstack",
  install: "npm i -D channelstack",
  version: VERSION,
  release: `https://github.com/christian-bromann/channelstack/releases/tag/v${VERSION}`,
  /** Where each package is published, for TypeScript, Python and Rust. */
  packages: [
    { registry: "npm", name: "channelstack", url: "https://www.npmjs.com/package/channelstack" },
    { registry: "PyPI", name: "pytest-channelstack", url: "https://pypi.org/project/pytest-channelstack/" },
    { registry: "crates.io", name: "channelstack", url: "https://crates.io/crates/channelstack" },
  ],
} as const;
